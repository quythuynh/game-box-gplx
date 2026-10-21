# game-box-gplx
# 🏎️ Đấu Trường Trắc Nghiệm GPLX B/B1 Realtime (2 - 4 Người Chơi)
### Chuẩn 600 Câu Hỏi Sát Hạch Bộ Công An (CV 2262/CSGT-P5 & Thông tư 12/2025/TT-BCA)

Ứng dụng web đối kháng trắc nghiệm lý thuyết lái xe ô tô hạng B/B1 dành cho **2 đến 4 người cùng thi đấu thời gian thực (Realtime)**:
* 🎯 **Sinh đề tự động:** 30 câu hỏi ngẫu nhiên chuẩn cấu trúc đề thi (đủ 6 chương + đảm bảo có câu điểm liệt).
* 🖱️ **Chuột Realtime đa chiều:** Nhìn thấy con trỏ chuột của đối thủ di chuyển trên màn hình theo thời gian thực (hiển thị màu sắc và avatar riêng).
* 🛡️ **Cơ chế chống nhìn bài:** Trong lúc làm bài, đối thủ chỉ biết bạn đang ở câu nào và đã hoàn thành bao nhiêu câu. Đáp án được bảo mật 100% đến khi nộp bài.
* 📝 **Kết quả hiển thị trực tiếp trên phần câu hỏi:** 
  - Đóng khung xanh lá nổi bật đáp án đúng `✓ ĐÁP ÁN ĐÚNG`.
  - Đánh dấu đáp án bạn đã chọn (Xanh nếu đúng, Đỏ nếu sai).
  - Hiển thị lựa chọn của từng người chơi khác bằng huy hiệu avatar + tên.
  - Hộp giải thích & căn cứ pháp lý (Luật TTATGTĐB 2024 & TT 12/2025/TT-BCA) xuất hiện ngay bên dưới các đáp án.
  - 30 nút Palette đổi màu Xanh (Đúng) / Đỏ (Sai) / Vàng (Liệt), bấm tới câu nào là xem ngay kết quả câu đó.
  - Bộ lọc thông minh: Tất cả (30 câu) / Chỉ câu làm sai / Câu điểm liệt.
* 🎵 **SoundEngine & Gamification:**
  - Bộ giả lập âm thanh Web Audio API (không phụ thuộc file ngoài): Âm thanh chọn câu, chuyển câu, nhạc hiệu chiến thắng bục Podium.
  - Thả cảm xúc Realtime: `🔥`, `🏎️`, `😂`, `😱`, `👏`, `💀`.
  - Pháo hoa Confetti chúc mừng người vượt qua bài thi.
* 💾 **Lưu trữ hành vi trên `localStorage`:**
  - Tự động ghi nhớ Profile & Avatar.
  - Lưu lịch sử các trận đấu (Điểm số, Đạt/Rớt, Thời gian làm bài, Số lần đổi ý).
  - Tự động thống kê và ghi nhớ **Danh sách các câu hỏi hay làm sai** để ôn tập lại.
* 🧪 **Test trực tiếp trên trình duyệt (Không cần viết testcase):**
  - Tích hợp nút **`🧪 Mở Tab 2 Test Ngay`**: Tự động mở tab mới, tự điền mã phòng và kết nối vào trận đấu.
* ⚡ **Không cần Database:** Chạy hoàn toàn trên dữ liệu JSON `data/questions_600_bca.json` và 318 ảnh sa hình cục bộ.
* ☁️ **Sẵn sàng triển khai Vercel:** Tệp cấu hình `vercel.json` phục vụ static frontend siêu tốc.

---

## 🚀 Hướng Dẫn Chạy & Thử Nghiệm

### 1. Cài đặt & Khởi động Server Local
```bash
# Cài đặt thư viện
npm install

# Chạy server
npm start
# Server chạy tại: http://localhost:3000
```

### 2. Trải nghiệm trên trình duyệt
1. Mở trình duyệt truy cập: **`http://localhost:3000`**
2. Nhập tên của bạn -> Bấm **"🚀 Tạo Phòng & Bắt Đầu"**.
3. Tại phòng chờ, bấm nút **`🧪 Mở Tab 2 Test Ngay`** để tự động mở thêm người chơi vào chung phòng.
4. Bấm **"🏁 Bắt Đầu Thi Đấu"** để bắt đầu tranh tài Realtime!

### 3. Kiểm thử tự động với 3 trình duyệt Chrome đồng thời
```bash
node test_socket_full.js
```

---

## 🌐 Triển khai lên Vercel
Dự án đã có sẵn file `vercel.json`, có thể deploy trực tiếp bằng Vercel CLI hoặc kết nối GitHub repo với Vercel:
```bash
npm install -g vercel
vercel
```

## 📜 Giấy phép
Mã nguồn mở theo giấy phép MIT. Bộ câu hỏi và hình ảnh thuộc bản quyền của Cục Cảnh sát giao thông (Bộ Công An).
