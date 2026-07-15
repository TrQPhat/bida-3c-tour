# Cue Arena — giải bida đấu loại trực tiếp

Ứng dụng gồm ba lớp độc lập: React frontend → BFF → API nghiệp vụ. Trình duyệt không gọi trực tiếp API.

## Chuẩn bị PostgreSQL (Neon)

Sao chép `.env.example` thành `.env`, sau đó đặt `DATABASE_URL` bằng connection string lấy từ Neon. Không commit file `.env`.

- Local: API đọc file `.env` duy nhất tại root repository.
- Render: cấu hình `DATABASE_URL` trong Environment Variables. Biến do Render cung cấp được ưu tiên và không phụ thuộc file `.env` hay working directory trên server.

Tạo hoặc cập nhật schema:

```bash
npm run migrate
```

Migration đã chạy được ghi trong bảng `schema_migrations`, vì vậy lệnh có thể chạy lại an toàn. Migration chỉ tạo schema; không tự tạo tài khoản demo và không tự sao chép dữ liệu SQLite cũ.

Kiểm tra trước khi chuyển dữ liệu SQLite cũ (không ghi vào Neon):

```bash
npm run import:sqlite
```

Chỉ khi dry-run báo `DRY RUN OK`, thực hiện import một lần:

```bash
npm run import:sqlite:execute
```

Script từ chối chạy nếu bất kỳ bảng ứng dụng nào trên Neon đã có dữ liệu. Toàn bộ import nằm trong một transaction, giữ nguyên ID/password hash và tự đồng bộ identity sequence.

## Chạy local

```bash
npm install
npm run dev
```

Mở `http://localhost:5173`. API cần kết nối được tới PostgreSQL đã cấu hình trong `DATABASE_URL`.

## Kiến trúc và bảo mật

- BFF tại `:4000` quản lý session bằng cookie `HttpOnly`, `SameSite=Strict`.
- Mọi mutation cần CSRF token. BFF kiểm tra role trước khi chuyển tiếp.
- API tại `:4001` không chấp nhận request thiếu internal key và tự kiểm tra role lần nữa.
- Mật khẩu băm bằng `scrypt` với salt riêng; login có rate limit.
- User chỉ đọc giải đấu/trận đấu và bình chọn. Admin quản trị tài khoản, đội, giải, lịch, chấp điểm và kết quả.
- Admin có thể tạm tắt đội để loại khỏi lần bốc thăm tiếp theo mà không xóa dữ liệu đội.
- Reset giải sẽ xóa bracket, tỷ số và bình chọn; danh sách đội và lịch sử bốc thăm gần nhất vẫn được giữ để lần tạo lại không lặp nguyên cách xếp trước đó.
- Bracket hỗ trợ mọi số lượng từ 2 đội: 2 đội vào thẳng chung kết, số đội không đủ lũy thừa 2 được bổ sung BYE và tự động tiến vòng.
- Điểm chấp hỗ trợ số thập phân như `0.5`, `1.5`.
- Dữ liệu được lưu trong PostgreSQL; môi trường deploy dự kiến dùng Neon.

## Production

Build frontend bằng `npm run build`, sau đó `npm start`. BFF phục vụ static frontend tại `:4000`; chỉ expose BFF ra Internet, giữ API trong private network. Bắt buộc đặt `SESSION_SECRET`, `INTERNAL_API_KEY`, HTTPS và đổi tài khoản demo.

## Render

Repository có `Dockerfile` và `render.yaml`. Trong Render Dashboard, tạo Blueprint từ repository và nhập `DATABASE_URL` khi được hỏi; Render tự sinh `INTERNAL_API_KEY` và `SESSION_SECRET`.

Trước khi gắn domain chính thức, chạy security smoke test bằng một tài khoản role `user`:

```powershell
$env:STAGING_URL='https://your-service.onrender.com'
$env:STAGING_TEST_USERNAME='your-test-user'
$env:STAGING_TEST_PASSWORD='your-test-password'
npm run test:staging
```

Các biến test chỉ đặt trong terminal local, không thêm vào `.env`, GitHub hoặc Render.
