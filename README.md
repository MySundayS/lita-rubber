# Python Google Sheets Realtime App

เว็บแอพพลิเคชันบันทึกข้อมูลลง Google Sheets และแสดงผลแบบ Realtime พัฒนาด้วย Python (Flask) และ JavaScript

## โครงสร้างโปรเจกต์ (Project Structure)
- `netlify/functions/api.py`: Backend (Flask) เชื่อมต่อ Google Sheets
- `public/index.html`: Frontend (HTML/JS) สำหรับกรอกและแสดงข้อมูล
- `netlify.toml`: ตั้งค่าสำหรับ deploy บน Netlify

## การติดตั้งและใช้งาน (Setup)

### 1. เตรียม Google Sheets
1. สร้าง Google Sheet ใหม่ และตั้งชื่อว่า **"MyDatabase"**
2. เปิดไฟล์ `credentials.json` ในโปรเจกต์นี้
3. คัดลอกอีเมลจากช่อง `"client_email"` (เช่น `service-account@...iam.gserviceaccount.com`)
4. กดปุ่ม **Share** (แชร์) ใน Google Sheet และวางอีเมลนั้นลงไป (ให้สิทธิ์ Editor)

### 2. รันบนเครื่อง (Local Run)
1. ติดตั้ง Library:
   ```bash
   pip install -r requirements.txt
   ```
2. รันโปรแกรม:
   ```bash
   python netlify/functions/api.py
   ```
3. เปิด Browser ไปที่: `http://localhost:5000`

### 3. อัพโหลดขึ้น Netlify (Deployment)
1. นำโค้ดขึ้น GitHub/GitLab
2. ไปที่ Netlify -> "Add new site" -> "Import an existing project"
3. เลือก Repository นี้
4. Netlify จะอ่านค่าจาก `netlify.toml` อัตโนมัติ
5. **สำคัญ:** ไปที่ **Site Settings > Environment variables**
   - สร้างตัวแปรชื่อ: `GOOGLE_CREDENTIALS`
   - ค่า (Value): ให้คัดลอกข้อความทั้งหมดจากไฟล์ `credentials.json` มาใส่ (เป็น JSON string)
6. รอ Deploy เสร็จ และเข้าใช้งานได้เลย

## หมายเหตุ
- ระบบใช้การ "Polling" (ดึงข้อมูลใหม่ทุก 5 วินาที) เพื่อจำลองการทำงานแบบ Realtime
- หากข้อมูลเยอะมาก อาจจะโหลดช้าลงเล็กน้อย (Google Sheets API Limit)
