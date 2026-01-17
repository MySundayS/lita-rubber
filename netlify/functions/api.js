const { google } = require("googleapis");

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

const SHEET_NAME = process.env.SHEET_NAME || "MyDatabase";

const WORKSHEETS = {
  rubber: "ข้อมูลยางพารา",
  expense: "บันทึกค่าใช้จ่าย",
  summary: "สรุปจำนวนเงิน",
};

let cachedAuth = null;
let cachedSpreadsheetId = null;
let cachedSheetIdByTitle = null;

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function parseJsonBody(event) {
  if (!event?.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function normalizePath(eventPath) {
  const raw = eventPath || "/";
  const withoutFnPrefix = raw.replace(/^\/\.netlify\/functions\/api/, "");
  return withoutFnPrefix === "" ? "/" : withoutFnPrefix;
}

function formatThaiMonthYear(dateStr) {
  try {
    const [yearStr, monthStr] = String(dateStr).split("-");
    const months = [
      "มกราคม",
      "กุมภาพันธ์",
      "มีนาคม",
      "เมษายน",
      "พฤษภาคม",
      "มิถุนายน",
      "กรกฎาคม",
      "สิงหาคม",
      "กันยายน",
      "ตุลาคม",
      "พฤศจิกายน",
      "ธันวาคม",
    ];
    const thaiYear = Number(yearStr) + 543;
    const monthIndex = Number(monthStr) - 1;
    const monthName = months[monthIndex];
    if (!monthName || !thaiYear) return "";
    return `${monthName} ${thaiYear}`;
  } catch {
    return "";
  }
}

function getServiceAccountCredentials() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) {
    throw new Error("Missing GOOGLE_CREDENTIALS env var");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_CREDENTIALS must be valid JSON");
  }
}

async function getAuth() {
  if (cachedAuth) return cachedAuth;

  const credentials = getServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  cachedAuth = await auth.getClient();
  return cachedAuth;
}

async function getSpreadsheetId(auth) {
  if (process.env.SPREADSHEET_ID) return process.env.SPREADSHEET_ID;
  if (cachedSpreadsheetId) return cachedSpreadsheetId;

  const drive = google.drive({ version: "v3", auth });
  const q = [
    `name = '${SHEET_NAME.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
    "trashed = false",
  ].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 5,
  });

  const file = (res.data.files || [])[0];
  if (!file?.id) {
    throw new Error(
      `Spreadsheet '${SHEET_NAME}' not found. Share it to the service account email in GOOGLE_CREDENTIALS, or set SPREADSHEET_ID.`
    );
  }

  cachedSpreadsheetId = file.id;
  return cachedSpreadsheetId;
}

async function getSheetsClient(auth) {
  return google.sheets({ version: "v4", auth });
}

async function getSheetIdByTitle(sheets, spreadsheetId) {
  if (cachedSheetIdByTitle) return cachedSheetIdByTitle;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });

  const map = {};
  for (const s of meta.data.sheets || []) {
    if (s?.properties?.title && typeof s.properties.sheetId === "number") {
      map[s.properties.title] = s.properties.sheetId;
    }
  }
  cachedSheetIdByTitle = map;
  return cachedSheetIdByTitle;
}

async function getNextRowIndex(sheets, spreadsheetId, sheetTitle, colLetter) {
  const range = `${sheetTitle}!${colLetter}:${colLetter}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];
  return values.length + 1;
}

async function handleGetData({ type, auth }) {
  const sheetTitle = WORKSHEETS[type];
  if (!sheetTitle) return jsonResponse(400, { error: "Invalid type" });

  const sheets = await getSheetsClient(auth);
  const spreadsheetId = await getSpreadsheetId(auth);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A:Z`,
  });

  const rows = res.data.values || [];
  const maxLen =
    rows.length === 0 ? 0 : Math.max(...rows.map((r) => (r ? r.length : 0)));

  const data = rows.map((row, i) => ({
    id: i + 1,
    values: (row || []).concat(Array(Math.max(0, maxLen - (row?.length || 0))).fill("")),
  }));

  return jsonResponse(200, data);
}

async function handleRecord({ type, event, auth }) {
  const sheetTitle = WORKSHEETS[type];
  if (!sheetTitle) return jsonResponse(400, { error: "Invalid type" });

  const body = parseJsonBody(event);
  const values = body?.values;
  if (!Array.isArray(values) || values.length === 0) {
    return jsonResponse(400, { error: "No values" });
  }

  const sheets = await getSheetsClient(auth);
  const spreadsheetId = await getSpreadsheetId(auth);

  if (type === "rubber") {
    const [name, amountRaw, priceRaw, dateStr, timeStr, zone, branch, statusRaw] =
      values;

    const amount = amountRaw ?? "";
    const price = priceRaw ?? "";
    const status = statusRaw || "ปกติ";

    let total = 0;
    const amountNum = Number(amountRaw);
    const priceNum = Number(priceRaw);
    if (Number.isFinite(amountNum) && Number.isFinite(priceNum)) {
      total = amountNum * priceNum;
    }

    const nextRow = await getNextRowIndex(sheets, spreadsheetId, sheetTitle, "B");
    const seq = nextRow - 1;
    const monthThai = formatThaiMonthYear(dateStr);

    const rowData = [
      seq,
      name ?? "",
      amount,
      price,
      total,
      dateStr ?? "",
      timeStr ?? "",
      zone ?? "",
      branch ?? "",
      status,
      monthThai,
      "",
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A${nextRow}:L${nextRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowData] },
    });

    return jsonResponse(200, {
      status: "success",
      message: `Rubber Record ${nextRow} added`,
    });
  }

  if (type === "expense") {
    const nextRow = await getNextRowIndex(sheets, spreadsheetId, sheetTitle, "A");
    const monthThai = formatThaiMonthYear(values[0]);
    const rowData = [values[0] ?? "", values[1] ?? "", values[2] ?? "", values[3] ?? "", values[4] ?? "", monthThai];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A${nextRow}:F${nextRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowData] },
    });

    return jsonResponse(200, {
      status: "success",
      message: `Expense added at row ${nextRow}`,
    });
  }

  if (type === "summary") {
    const nextRow = await getNextRowIndex(sheets, spreadsheetId, sheetTitle, "A");
    const monthThai = formatThaiMonthYear(values[0]);
    const rowData = [
      values[0] ?? "",
      values[1] ?? "",
      values[2] ?? 0,
      values[3] ?? 0,
      values[4] ?? 0,
      values[5] ?? 0,
      values[6] ?? 0,
      values[7] ?? 0,
      values[8] ?? 0,
      values[9] ?? "",
      monthThai,
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A${nextRow}:K${nextRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowData] },
    });

    return jsonResponse(200, {
      status: "success",
      message: `Summary added at row ${nextRow}`,
    });
  }

  return jsonResponse(400, { error: "Invalid type" });
}

async function handleDelete({ type, rowId, auth }) {
  const sheetTitle = WORKSHEETS[type];
  if (!sheetTitle) return jsonResponse(400, { error: "Invalid type" });
  if (!Number.isInteger(rowId) || rowId <= 1) {
    return jsonResponse(400, { error: "Invalid row_id" });
  }

  const sheets = await getSheetsClient(auth);
  const spreadsheetId = await getSpreadsheetId(auth);
  const sheetIdMap = await getSheetIdByTitle(sheets, spreadsheetId);
  const sheetId = sheetIdMap[sheetTitle];
  if (typeof sheetId !== "number") {
    return jsonResponse(500, { error: `Worksheet '${sheetTitle}' not found` });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowId - 1,
              endIndex: rowId,
            },
          },
        },
      ],
    },
  });

  return jsonResponse(200, {
    status: "success",
    message: `Row ${rowId} deleted`,
  });
}

async function handleUpdate({ type, rowId, event, auth }) {
  const sheetTitle = WORKSHEETS[type];
  if (!sheetTitle) return jsonResponse(400, { error: "Invalid type" });
  if (!Number.isInteger(rowId) || rowId <= 1) {
    return jsonResponse(400, { error: "Invalid row_id" });
  }

  const body = parseJsonBody(event);
  const values = body?.values;
  if (!Array.isArray(values) || values.length === 0) {
    return jsonResponse(400, { error: "No values" });
  }

  const sheets = await getSheetsClient(auth);
  const spreadsheetId = await getSpreadsheetId(auth);

  if (type === "rubber") {
    const [name, amountRaw, priceRaw, dateStr, timeStr, zone, branch, statusRaw] =
      values;
    const status = statusRaw || "ปกติ";

    let total = 0;
    const amountNum = Number(amountRaw);
    const priceNum = Number(priceRaw);
    if (Number.isFinite(amountNum) && Number.isFinite(priceNum)) {
      total = amountNum * priceNum;
    }

    const monthThai = formatThaiMonthYear(dateStr);
    const rowData = [
      name ?? "",
      amountRaw ?? "",
      priceRaw ?? "",
      total,
      dateStr ?? "",
      timeStr ?? "",
      zone ?? "",
      branch ?? "",
      status,
      monthThai,
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!B${rowId}:K${rowId}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowData] },
    });

    return jsonResponse(200, { status: "success", message: `Row ${rowId} updated` });
  }

  if (type === "expense") {
    const monthThai = formatThaiMonthYear(values[0]);
    const rowData = [values[0] ?? "", values[1] ?? "", values[2] ?? "", values[3] ?? "", values[4] ?? "", monthThai];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A${rowId}:F${rowId}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowData] },
    });

    return jsonResponse(200, { status: "success", message: `Row ${rowId} updated` });
  }

  if (type === "summary") {
    const monthThai = formatThaiMonthYear(values[0]);
    const rowData = [
      values[0] ?? "",
      values[1] ?? "",
      values[2] ?? 0,
      values[3] ?? 0,
      values[4] ?? 0,
      values[5] ?? 0,
      values[6] ?? 0,
      values[7] ?? 0,
      values[8] ?? 0,
      values[9] ?? "",
      monthThai,
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A${rowId}:K${rowId}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowData] },
    });

    return jsonResponse(200, { status: "success", message: `Row ${rowId} updated` });
  }

  return jsonResponse(400, { error: "Invalid type" });
}

exports.handler = async (event) => {
  try {
    const auth = await getAuth();
    const path = normalizePath(event.path);
    const method = (event.httpMethod || "GET").toUpperCase();

    if (method === "GET" && (path === "/health" || path === "/api/health" || path === "/")) {
      return jsonResponse(200, { status: "ok" });
    }

    const parts = path.split("/").filter(Boolean);

    if (method === "GET" && parts[0] === "data" && parts[1]) {
      return await handleGetData({ type: parts[1], auth });
    }

    if (method === "POST" && parts[0] === "record" && parts[1]) {
      return await handleRecord({ type: parts[1], event, auth });
    }

    if (method === "DELETE" && parts[0] === "delete" && parts[1] && parts[2]) {
      const rowId = Number(parts[2]);
      return await handleDelete({ type: parts[1], rowId, auth });
    }

    if (method === "POST" && parts[0] === "update" && parts[1] && parts[2]) {
      const rowId = Number(parts[2]);
      return await handleUpdate({ type: parts[1], rowId, event, auth });
    }

    return jsonResponse(404, { error: "Not Found" });
  } catch (e) {
    return jsonResponse(500, { error: String(e?.message || e) });
  }
};

