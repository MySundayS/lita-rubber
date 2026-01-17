import os
import json
import awsgi
from flask import Flask, request, jsonify
import gspread
from google.oauth2.service_account import Credentials

app = Flask(__name__)

# Handle 404 errors with JSON response
@app.errorhandler(404)
def resource_not_found(e):
    return jsonify(error=str(e)), 404

# Configuration
SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
SHEET_NAME = os.environ.get('SHEET_NAME', 'MyDatabase')
WORKSHEET_RUBBER = "ข้อมูลยางพารา"
WORKSHEET_EXPENSE = "บันทึกค่าใช้จ่าย"
WORKSHEET_SUMMARY = "สรุปจำนวนเงิน"

# Global cache
_sheet_client = None
_sheet_obj = None # Cache for Spreadsheet object (the file)
_worksheets_cache = {} # Cache for Worksheet objects: {'name': worksheet_obj}

def format_thai_month_year(date_str):
    try:
        # date_str is YYYY-MM-DD
        year, month, day = date_str.split('-')
        months = [
            "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
            "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
        ]
        thai_year = int(year) + 543
        month_name = months[int(month) - 1]
        return f"{month_name} {thai_year}"
    except:
        return ""

def get_creds():
    # ... (No change) ...
    # 1. Try Environment Variable (For Netlify Production)
    if 'GOOGLE_CREDENTIALS' in os.environ:
        # print("Loading credentials from Environment Variable") # Reduce noise
        try:
            creds_json = json.loads(os.environ['GOOGLE_CREDENTIALS'])
            return Credentials.from_service_account_info(creds_json, scopes=SCOPES)
        except Exception as e:
            print(f"Error loading env creds: {e}")
            
    # 2. Try Local File (For Local Development)
    # Look in current directory or up one level
    possible_paths = ['credentials.json', '../credentials.json', '../../credentials.json']
    for path in possible_paths:
        if os.path.exists(path):
            # print(f"Loading credentials from {path}") # Reduce noise
            return Credentials.from_service_account_file(path, scopes=SCOPES)
            
    return None

def get_spreadsheet():
    global _sheet_client, _sheet_obj, _worksheets_cache
    
    # Return cached spreadsheet if available
    if _sheet_obj:
        return _sheet_obj

    creds = get_creds()
    if not creds:
        raise Exception("Credentials not found. Please set GOOGLE_CREDENTIALS env var or have credentials.json")
    
    client = gspread.authorize(creds)
    _sheet_client = client 
    
    try:
        sh = client.open(SHEET_NAME)
        _sheet_obj = sh
        _worksheets_cache = {} # Reset worksheet cache when spreadsheet is reloaded
        return sh
    except gspread.exceptions.SpreadsheetNotFound:
        email = creds.service_account_email
        raise Exception(f"Spreadsheet '{SHEET_NAME}' not found. Please create a Google Sheet named '{SHEET_NAME}' and share it with: {email}")

def get_worksheet(name):
    global _worksheets_cache
    
    # Return cached worksheet if available
    if name in _worksheets_cache:
        return _worksheets_cache[name]
        
    sh = get_spreadsheet()
    try:
        ws = sh.worksheet(name)
        _worksheets_cache[name] = ws # Cache it
        return ws
    except gspread.exceptions.WorksheetNotFound:
        # If specific sheet not found, try creating it? Or just error.
        # For safety, let's error but with clear message
        raise Exception(f"Worksheet '{name}' not found in '{SHEET_NAME}'. Please create it.")
    except Exception as e:
        # If any other error (like disconnected), clear cache and retry once
        global _sheet_obj
        _sheet_obj = None
        _worksheets_cache = {}
        sh = get_spreadsheet()
        ws = sh.worksheet(name)
        _worksheets_cache[name] = ws
        return ws

@app.route('/record/rubber', methods=['POST'])
@app.route('/api/record/rubber', methods=['POST'])
def record_rubber():
    try:
        data = request.json
        values = data.get('values') # [Name, Amount, Price, Date, Time, Zone, Branch, Status]
        if not values: return jsonify({"error": "No values"}), 400
        
        ws = get_worksheet(WORKSHEET_RUBBER)
        
        # Smart Append Logic for Rubber Sheet
        # Header: ลำดับ, รายชื่อ, จำนวนยาง, ราคา, จำนวนเงิน, วันที่, เวลา, กอง, สาขา, สถานะ, เดือน, หมายเหตุ
        # Index:  A(1), B(2),  C(3),    D(4), E(5),     F(6), G(7), H(8), I(9), J(10), K(11), L(12)
        
        # Find next empty row based on Name (Col B)
        col_b = ws.col_values(2)
        next_row = len(col_b) + 1
        seq = next_row - 1
        
        name = values[0]
        amount = values[1]
        price = values[2]
        date_str = values[3]
        time_str = values[4]
        zone = values[5]
        branch = values[6]
        status = values[7] if len(values) > 7 else "ปกติ"
        
        # Calculate Total (Amount * Price) if both are numbers
        try:
            total = float(amount) * float(price)
        except:
            total = 0
            
        row_data = [
            seq,        # A: Seq
            name,       # B: Name
            amount,     # C: Amount
            price,      # D: Price
            total,      # E: Total
            date_str,   # F: Date
            time_str,   # G: Time
            zone,       # H: Zone
            branch,     # I: Branch
            status,     # J: Status
            format_thai_month_year(date_str), # K: Month (mmmm yyyy)
            ""          # L: Note
        ]
        
        ws.update(f'A{next_row}:L{next_row}', [row_data])
        return jsonify({"status": "success", "message": f"Rubber Record {next_row} added"}), 200
    except Exception as e:
        global _sheet_obj
        _sheet_obj = None
        return jsonify({"error": str(e)}), 500

@app.route('/record/expense', methods=['POST'])
@app.route('/api/record/expense', methods=['POST'])
def record_expense():
    try:
        data = request.json
        values = data.get('values') # [Date, Branch, Type, ExpenseName, Amount]
        if not values: return jsonify({"error": "No values"}), 400
        
        ws = get_worksheet(WORKSHEET_EXPENSE)
        
        # Use col_values to find next empty row (Column A - Date)
        col_a = ws.col_values(1)
        next_row = len(col_a) + 1
        
        # Header: วันที่, สาขา, ประเภท, รายจ่าย, จำนวนเงิน, เดือน
        # Range: A-F
        values.append(format_thai_month_year(values[0])) # Add Month column
        ws.update(f'A{next_row}:F{next_row}', [values])
        
        return jsonify({"status": "success", "message": f"Expense added at row {next_row}"}), 200
    except Exception as e:
        global _sheet_obj
        _sheet_obj = None
        return jsonify({"error": str(e)}), 500

@app.route('/record/summary', methods=['POST'])
@app.route('/api/record/summary', methods=['POST'])
def record_summary():
    try:
        data = request.json
        values = data.get('values') 
        # [Date, Branch, 1000, 500, 100, 50, 20, Coins, Total, Status]
        if not values: return jsonify({"error": "No values"}), 400
        
        ws = get_worksheet(WORKSHEET_SUMMARY)
        
        # Use col_values to find next empty row (Column A - Date)
        col_a = ws.col_values(1)
        next_row = len(col_a) + 1
        
        # Range: A-K
        values.append(format_thai_month_year(values[0])) # Add Month column
        ws.update(f'A{next_row}:K{next_row}', [values])
        
        return jsonify({"status": "success", "message": f"Summary added at row {next_row}"}), 200
    except Exception as e:
        global _sheet_obj
        _sheet_obj = None
        return jsonify({"error": str(e)}), 500

@app.route('/data/<type>', methods=['GET'])
@app.route('/api/data/<type>', methods=['GET'])
def get_data_by_type(type):
    ws = None
    if type == 'rubber':
        ws = get_worksheet(WORKSHEET_RUBBER)
    elif type == 'expense':
        ws = get_worksheet(WORKSHEET_EXPENSE)
    elif type == 'summary':
        ws = get_worksheet(WORKSHEET_SUMMARY)
    
    if ws:
        rows = ws.get_all_values()
        
        # Pad rows to ensure consistent length
        if rows:
            max_len = max(len(r) for r in rows)
            rows = [r + [''] * (max_len - len(r)) for r in rows]
            
        # Return list of objects with id (row index) and values
        data = [{'id': i + 1, 'values': row} for i, row in enumerate(rows)]
        return jsonify(data), 200
    return jsonify([]), 404

@app.route('/delete/<type>/<int:row_id>', methods=['DELETE'])
@app.route('/api/delete/<type>/<int:row_id>', methods=['DELETE'])
def delete_record(type, row_id):
    ws = None
    if type == 'rubber':
        ws = get_worksheet(WORKSHEET_RUBBER)
    elif type == 'expense':
        ws = get_worksheet(WORKSHEET_EXPENSE)
    elif type == 'summary':
        ws = get_worksheet(WORKSHEET_SUMMARY)
        
    if ws:
        try:
            ws.delete_rows(row_id)
            return jsonify({"status": "success", "message": f"Row {row_id} deleted"}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Invalid type"}), 400

@app.route('/update/<type>/<int:row_id>', methods=['POST'])
@app.route('/api/update/<type>/<int:row_id>', methods=['POST'])
def update_record(type, row_id):
    try:
        data = request.json
        values = data.get('values')
        if not values: return jsonify({"error": "No values"}), 400
        
        ws = None
        if type == 'rubber':
            ws = get_worksheet(WORKSHEET_RUBBER)
            # values: [Name, Amount, Price, Date, Time, Zone, Branch, Status]
            name = values[0]
            amount = values[1]
            price = values[2]
            date_str = values[3]
            time_str = values[4]
            zone = values[5]
            branch = values[6]
            status = values[7]
            
            try:
                total = float(amount) * float(price)
            except:
                total = 0
                
            # Update B to K
            # B:Name, C:Amount, D:Price, E:Total, F:Date, G:Time, H:Zone, I:Branch, J:Status, K:Month
            month_thai = format_thai_month_year(date_str)
            row_data = [name, amount, price, total, date_str, time_str, zone, branch, status, month_thai]
            ws.update(f'B{row_id}:K{row_id}', [row_data])
            
        elif type == 'expense':
            ws = get_worksheet(WORKSHEET_EXPENSE)
            # values: [Date, Branch, Type, Item, Amount]
            # Update A to F
            values.append(format_thai_month_year(values[0])) # Add Month column
            ws.update(f'A{row_id}:F{row_id}', [values])
            
        elif type == 'summary':
            ws = get_worksheet(WORKSHEET_SUMMARY)
            # values: [Date, Branch, 1000, 500, 100, 50, 20, Coins, Total, Status]
            # Update A to K
            values.append(format_thai_month_year(values[0])) # Add Month column
            ws.update(f'A{row_id}:K{row_id}', [values])
            
        if ws:
            return jsonify({"status": "success", "message": f"Row {row_id} updated"}), 200
        return jsonify({"error": "Invalid type"}), 400
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/data', methods=['GET'])
def get_data():
    try:
        sh = get_sheet()
        # get_all_values returns a list of lists (rows)
        rows = sh.get_all_values()
        return jsonify(rows), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"}), 200

def handler(event, context):
    return awsgi.response(app, event, context)

if __name__ == '__main__':
    # Local development server
    # Serve static files for local dev
    from flask import send_from_directory
    
    # Adjust path to point to public folder (2 levels up from netlify/functions)
    public_folder = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../public'))
    
    @app.route('/')
    def index():
        return send_from_directory(public_folder, 'index.html')
    
    @app.route('/<path:path>')
    def static_files(path):
        return send_from_directory(public_folder, path)

    print(f"Serving static files from {public_folder}")
    app.run(debug=True, port=5000)
