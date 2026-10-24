# KEYVN — Node.js + SQLite + SePay webhook

Starter project cho website bán sản phẩm số có tài khoản, ví nội bộ, lịch sử giao dịch, mua bằng số dư và webhook nạp ví bằng chuyển khoản ngân hàng qua SePay.

## Quan trọng trước khi dùng thật

- Không có chế độ “bấm xác nhận đã thanh toán”. Số dư chỉ được cộng khi webhook SePay có chữ ký HMAC hợp lệ, timestamp còn mới, giao dịch tiền vào, khớp tài khoản nhận (nếu cấu hình), mã nạp do server tạo và số tiền khớp chính xác.
- Webhook được thiết kế theo tài liệu SePay HMAC-SHA256: `X-SePay-Signature: sha256=...`, `X-SePay-Timestamp`, chữ ký trên chuỗi `{timestamp}.{raw_body}`.
- Chưa thể nhận tiền thật cho đến khi bạn tạo tài khoản SePay, liên kết tài khoản ngân hàng, cấu hình webhook và điền các biến `.env`. Không dùng test mode để xác nhận thanh toán thật.
- QR VietQR trong trang nạp ví là QR chuyển khoản theo thông tin bạn cấu hình. Phải xác minh lại ngân hàng, BIN, số tài khoản và tên chủ tài khoản trước khi bật production.
- Sản phẩm là dữ liệu demo. Hãy thay ảnh, mô tả, giá và chỉ bán sản phẩm bạn có quyền phân phối.
- Ví nội bộ có thể kéo theo nghĩa vụ pháp lý/quy định tài chính tùy mô hình kinh doanh và khu vực. Xác nhận yêu cầu pháp lý/nhà cung cấp thanh toán trước khi triển khai.

## Yêu cầu

- Node.js 20+
- npm
- Tài khoản SePay với tài khoản ngân hàng đã liên kết
- Máy chủ public HTTPS cho production

## Chạy local

```bash
npm install
cp .env.example .env
```

Sửa `.env`:
- `SESSION_SECRET`: chuỗi ngẫu nhiên tối thiểu 32 ký tự.
- `BASE_URL=http://localhost:3000`
- `BANK_BIN`, `BANK_ACCOUNT_NUMBER`, `BANK_ACCOUNT_NAME`: thông tin tài khoản nhận tiền chính xác.
- `SEPAY_WEBHOOK_SECRET`: secret HMAC lấy khi tạo webhook SePay.

Chạy:

```bash
npm run dev
```

Mở http://localhost:3000

Tạo tài khoản thường qua giao diện. Tạo admin qua terminal:

```bash
npm run admin:create
```

Script hỏi username/email/password và yêu cầu mật khẩu admin tối thiểu 14 ký tự. Không có tài khoản admin mặc định.

## Cấu hình SePay cho thanh toán thật

1. Đăng nhập dashboard SePay, liên kết đúng tài khoản ngân hàng nhận tiền.
2. Tạo Webhook với sự kiện **Có tiền vào / In_only**.
3. URL webhook: `https://TEN-MIEN-CUA-BAN/api/webhooks/sepay`
4. Chọn xác thực **HMAC-SHA256**, không chọn “None”.
5. Lưu secret HMAC vào `SEPAY_WEBHOOK_SECRET`.
6. Nếu muốn khóa đúng tài khoản ngân hàng nhận tiền, đặt `SEPAY_BANK_ACCOUNT_NUMBER` bằng số tài khoản ngân hàng được webhook báo trong `accountNumber`.
7. Deploy HTTPS, cập nhật `BASE_URL=https://TEN-MIEN-CUA-BAN`, `NODE_ENV=production` và `SESSION_SECRET`.
8. Tạo yêu cầu nạp trong website; khách chuyển đúng số tiền và giữ nguyên `paymentCode` làm nội dung chuyển khoản.
9. Thử với khoản tiền nhỏ thực tế; xem log webhook của SePay và log ứng dụng. Không đánh dấu nạp tiền thủ công để “test”.

Tài liệu chính thức:
- https://developer.sepay.vn/vi
- https://developer.sepay.vn/en/sepay-webhooks/xac-thuc
- https://docs.sepay.vn/tich-hop-webhooks.html

## Luồng nạp tiền

1. Người dùng đăng nhập và tạo deposit; backend tạo mã `KV...` ngẫu nhiên và lưu trạng thái `pending`.
2. Trang hiển thị QR VietQR với đúng số tiền + mã nạp.
3. Ngân hàng ghi nhận tiền vào; SePay gửi webhook có chữ ký.
4. Server xác minh HMAC trên raw body, timestamp ±5 phút, event ID, chiều tiền vào, tài khoản nhận, mã nạp và số tiền.
5. Một transaction SQLite ghi event ID, chuyển deposit từ pending sang paid, cộng số dư và ghi ledger. Unique constraints giúp chống xử lý lặp.
6. Giao dịch không khớp không được cộng tiền.

## Giao key

- Endpoint admin `POST /api/admin/products/:id/keys` nhận JSON `{ "keys": ["KEY-001", "KEY-002"] }`.
- Admin cần đăng nhập, endpoint chỉ nhận bởi role admin.
- Checkout bắt buộc có đủ key trong kho và giao key trong cùng transaction với việc trừ số dư/kho; hệ thống không thu tiền nếu chưa thể giao sản phẩm.
- Dữ liệu sản phẩm mặc định chỉ là mẫu. Nạp key thật vào kho trước khi cho khách mua.
- Endpoint admin tạo sản phẩm: `POST /api/admin/products` với `name, category, description, price, stock, imageUrl`.
- Endpoint admin sửa sản phẩm: `PATCH /api/admin/products/:id`.
- Endpoint admin xem nạp tiền: `GET /api/admin/deposits`, đơn hàng: `GET /api/admin/orders`, tổng quan: `GET /api/admin/summary`.

Các endpoint admin hiện có thể thao tác qua API client (cookie session) hoặc bổ sung dashboard admin riêng. Không đưa mật khẩu, secret webhook hay API key vào frontend.

## API chính

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/products`
- `POST /api/wallet/deposits`
- `GET /api/wallet/deposits`
- `GET /api/wallet/transactions`
- `POST /api/orders`
- `GET /api/orders`
- `POST /api/webhooks/sepay` (webhook provider, không dùng từ frontend)

## Production checklist

- HTTPS bắt buộc; `NODE_ENV=production`, `BASE_URL` HTTPS, secret mạnh.
- Dùng reverse proxy có TLS, firewall, sao lưu database định kỳ và giám sát lỗi.
- Giới hạn quyền truy cập hệ điều hành vào `.env` và file SQLite.
- Dùng mật khẩu admin mạnh; không dùng admin chung.
- Kiểm tra kỹ cấu hình webhook trong dashboard SePay và đối chiếu giao dịch thực.
- Có quy trình hoàn tiền/đối soát và liên hệ hỗ trợ.
- Nên dùng database managed (PostgreSQL) và backup phù hợp nếu website có lưu lượng lớn.
- Tích hợp email xác nhận, reset mật khẩu, log kiểm toán và chính sách bảo mật trước khi mở công khai.

## Tính năng đã bổ sung trong bản KEYVN v2

- Thanh toán đơn hàng chỉ bằng số dư ví nội bộ; không có nút xác nhận thanh toán thủ công.
- Nạp ví qua chuyển khoản ngân hàng và webhook SePay đã xác minh chữ ký. Đây là bước nạp số dư; checkout vẫn dùng ví.
- Giao key tự động trong cùng transaction với việc trừ số dư. Nếu kho key không đủ, đơn hàng bị từ chối và không trừ tiền.
- Lịch sử ví, lịch sử nạp, đơn hàng và sổ kiểm toán giao dịch dành cho admin.
- Mã giảm giá dạng phần trăm hoặc số tiền cố định; giới hạn tổng đơn, lượt dùng và ngày hết hạn.
- Hạng thành viên theo tổng giá trị đơn hàng đã thanh toán: Đồng, Bạc (100.000đ), Vàng (500.000đ), Kim cương (1.000.000đ).
- Phiếu hỗ trợ khách hàng; admin trả lời hoặc đóng phiếu.
- Admin tạo sản phẩm, nạp key, quản lý mã giảm giá và xem giao dịch ví.
- Tồn kho được tính theo số key khả dụng thật trong kho, không dùng số lượng demo để báo hàng.

## Triển khai VPS Ubuntu + tên miền + HTTPS (Nginx)

1. Trỏ bản ghi DNS `A` của tên miền về IP public VPS; mở TCP 22, 80 và 443.
2. Cài Node.js 20+, npm, Nginx và Certbot trên VPS.
3. Tải/giải nén thư mục `keyvn` lên `/opt/keyvn`, rồi chạy `npm install` trong thư mục đó.
4. Tạo `.env` từ `.env.example`, cấu hình `NODE_ENV=production`, `BASE_URL=https://TEN-MIEN-CUA-BAN`, `PORT=3000`, `SESSION_SECRET` ngẫu nhiên mạnh, thông tin ngân hàng và `SEPAY_WEBHOOK_SECRET` thật. Không đưa `.env` vào Git hoặc gửi cho người khác.
5. Tạo admin bằng `npm run admin:create`; không dùng tài khoản/mật khẩu mặc định.
6. Tạo Nginx site proxy đến `http://127.0.0.1:3000`, bật `proxy_set_header Host $host`, `X-Real-IP $remote_addr`, `X-Forwarded-For $proxy_add_x_forwarded_for` và `X-Forwarded-Proto $scheme`.
7. Cấp chứng chỉ: `sudo certbot --nginx -d TEN-MIEN-CUA-BAN`; xác nhận gia hạn tự động hoạt động.
8. Chạy Node.js bằng systemd hoặc PM2, không chạy bằng terminal phiên SSH. Ví dụ systemd service cần `WorkingDirectory=/opt/keyvn`, `ExecStart=/usr/bin/node /opt/keyvn/src/server.js`, `Restart=on-failure`, user hệ thống không phải root và `EnvironmentFile=/opt/keyvn/.env`.
9. Đặt quyền hạn chế: `.env` chỉ user dịch vụ đọc được; thư mục `data/` cần quyền ghi cho user dịch vụ và không được phục vụ công khai qua Nginx.
10. Trong SePay, tạo webhook **HMAC-SHA256**, sự kiện **tiền vào**, URL `https://TEN-MIEN-CUA-BAN/api/webhooks/sepay`, lưu secret vào `.env` và khởi động lại ứng dụng.
11. Thực hiện giao dịch ngân hàng thật với số tiền nhỏ, đúng mã nạp, kiểm tra SePay delivery logs và lịch sử ví. Không dùng Test mode hoặc tự tạo HTTP request để giả lập giao dịch khi nghiệm thu thanh toán thật.

Ví dụ Nginx tối thiểu (thay tên miền thật):

```nginx
server {
    listen 80;
    server_name TEN-MIEN-CUA-BAN;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Sau đó chạy Certbot để tự thêm cấu hình HTTPS. Hãy giới hạn firewall, bật cập nhật bảo mật hệ điều hành, sao lưu SQLite định kỳ và kiểm tra log. Trước khi mở bán, thay dữ liệu/ảnh mẫu, tạo sản phẩm thật, nạp key có quyền phân phối và xác minh chính sách pháp lý áp dụng cho ví nội bộ.
