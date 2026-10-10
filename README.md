# Desktop Commander Manager

Hệ thống quản lý, giám sát và định tuyến Model Context Protocol (MCP) hiệu năng cao cho các worker [Desktop Commander](https://github.com/wonderwhy-er/desktop-commander), hỗ trợ cả **Windows** và **Ubuntu / Linux**.

---

## 🌟 Tính năng nổi bật

- **Endpoint MCP Streamable HTTP chuẩn hóa:** Lắng nghe tại `http://127.0.0.1:8787/mcp`.
- **Hỗ trợ kết nối ChatGPT:** Kết nối an toàn trực tiếp từ ChatGPT qua **OpenAI Secure MCP Tunnel** hoặc các reverse proxy an toàn mà không cần mở port ra ngoài internet.
- **Tối ưu hóa hiệu năng bằng Rust:** Lõi quản lý tiến trình, SQLite WAL state repository, sticky-session router, API và static server viết bằng Rust.
  - **Giảm 58% - 88% dung lượng RAM** so với Node.js thuần (Rust core chỉ tốn ~8.6 MB RSS).
  - **Khởi động siêu nhanh:** Chỉ ~210 ms (nhanh hơn ~70%).
  - **Độ trễ định tuyến cực thấp:** `tools/call` p95 chỉ ~9 ms (giảm 68% độ trễ).
  - **Lấy snapshot tài nguyên Win32/Linux native:** Giảm 99.5% độ trễ (chỉ ~11 ms), 0 tiến trình phụ.
- **Tự phục hồi và bảo toàn phiên (Sticky Sessions):**
  - Quản lý đồng thời các worker Desktop Commander chạy độc lập (`worker-1`, `worker-2`), cô lập thư mục môi trường.
  - Tự động phát hiện crash và khởi động lại worker trong < 100 ms mà không làm đứt kết nối phiên hội thoại ChatGPT đang diễn ra.
- **Giao diện Web Dashboard:** Tích hợp sẵn tại `http://127.0.0.1:8788/` để theo dõi tài nguyên, sessions, tool calls và thao tác restart/disable workers trực quan.
- **Đa nền tảng:** Hỗ trợ native cả Windows (Win32 API) và Ubuntu/Linux (`crates/manager-linux`).

---

## 📦 Cách chạy nhanh (Không cần cài Rust, không cần source code)

Nếu bạn chuyển sang máy khác và muốn sử dụng ngay mà **không cần cài đặt Rust compiler hay tải mã nguồn**:

### Cách 1: Tải bản đóng gói Release
1. Vào mục [Releases](https://github.com/hongsonng/desktop-commander-manager/releases) của repository.
2. Tải gói tương ứng với hệ điều hành:
   * **Windows:** Tải `desktop-commander-manager-windows-x64.zip` (~2.3 MB).
     * Giải nén thư mục.
     * Click đúp vào `start.bat` để chạy ngay.
   * **Ubuntu / Linux:** Tải `desktop-commander-manager-linux-x64.tar.gz`.
     * Giải nén: `tar -xzf desktop-commander-manager-linux-x64.tar.gz`
     * Chạy ngay: `./start.sh`
     * (Tùy chọn) Cài làm dịch vụ chạy ngầm tự khởi động cùng hệ thống: `./install-service.sh`
3. Mở trình duyệt truy cập: `http://127.0.0.1:8788/` để xem Dashboard.

### Cách 2: Tự đóng gói từ source code
Nếu bạn có mã nguồn và muốn đóng gói ra file zip/tar.gz:
* **Trên Windows:** Chạy `powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1`
* **Trên Linux:** Chạy `bash scripts/package-release.sh`
File cài đặt sẽ được tạo tự động trong thư mục `dist-release/`.

---

## 🤖 HƯỚNG DẪN KẾT NỐI VỚI CHATGPT

Hệ thống cho phép kết nối ChatGPT với máy tính của bạn theo mô hình bảo mật:

```text
ChatGPT (Web / App)
  │
  ▼
OpenAI Secure MCP Tunnel (hoặc Cloudflare Tunnel / ngrok)
  │
  ▼ (Mã hóa đầu cuối)
Desktop Commander Manager (http://127.0.0.1:8787/mcp)
  │
  ▼ (Quản lý phiên, tự phục hồi, cách ly runtime)
Desktop Commander Workers (Local PC)
```

> 📸 **Xem hướng dẫn chi tiết có hình ảnh minh họa:** 👉 [**docs/huong-dan-ket-noi-chatgpt.md**](docs/huong-dan-ket-noi-chatgpt.md) *(Bao gồm ảnh chụp màn hình từng bước cấu hình OpenAI Tunnel, Custom GPT Action và giao diện chat thực tế)*

### Phương thức 1: Kết nối chính thức qua OpenAI Secure MCP Tunnel (Khuyên dùng)

Đây là phương thức bảo mật nhất: máy tính của bạn chỉ tạo kết nối outbound an toàn đến OpenAI, **không cần mở port router**, **không lộ IP**, và tự động khôi phục kết nối.

#### Bước 1: Khởi động Manager
Đảm bảo Desktop Commander Manager đang chạy:
* Kiểm tra `http://127.0.0.1:8788/api/health` trả về `{"status":"ok"}`.

#### Bước 2: Tạo Tunnel trên OpenAI Platform
1. Đăng nhập [OpenAI Platform](https://platform.openai.com/).
2. Vào **Settings** -> **Organization** -> **Security** -> **Tunnels** (hoặc truy cập trực tiếp: `https://platform.openai.com/settings/organization/security/tunnels`).
3. Nhấn **Create Tunnel**, đặt tên (ví dụ: `desktop-commander-manager`), sau đó sao chép lại **Tunnel ID** (dạng `tun_...`).
4. Vào mục **API Keys** trên OpenAI Platform:
   * Tạo một **Restricted Key** mới.
   * Cấp quyền: **Tunnels: Read + Use**.
   * Sao chép mã API Key vừa tạo (dạng `sk-...`).

#### Bước 3: Cấu hình Tunnel tự động trên máy tính
1. Trong thư mục repository hoặc gói giải nén, click đúp file:
   ```text
   setup-tunnel.bat
   ```
   *(Hoặc trên PowerShell: `powershell -ExecutionPolicy Bypass -File scripts/setup-tunnel.ps1`)*.
2. Dán **Tunnel ID** và **Restricted API Key** khi được hỏi.
   > 🔒 **Bảo mật:** API Key được lưu an toàn tại `%APPDATA%\tunnel-client\secrets\desktop-commander-manager.api-key` với quyền chỉ người dùng hiện tại được đọc. Không bao giờ lưu key vào source code hay Git.
3. Script sẽ tự động chạy lệnh kiểm tra kết nối (`tunnel-client doctor`) và kích hoạt watchdog tự động duy trì kết nối cho tunnel.

#### Bước 4: Kích hoạt kết nối trong ChatGPT
1. Mở [ChatGPT](https://chatgpt.com/).
2. Truy cập **Settings** -> **Apps / Connectors** (hoặc tạo Custom GPT trong phần **Actions / MCP Tools**).
3. Chọn loại kết nối là **OpenAI Secure Tunnel**.
4. Chọn đúng **Tunnel ID** bạn đã tạo ở Bước 2.
5. ChatGPT sẽ tự động xác thực và nhận diện các công cụ của Desktop Commander:
   * `execute_command`: Thực thi lệnh an toàn.
   * `read_file`, `write_file`, `edit_block`: Đọc và chỉnh sửa file trên máy.
   * `list_directory`: Liệt kê cây thư mục.
   * `get_config`: Xem cấu hình hệ thống.

#### Bước 5: Trải nghiệm trong ChatGPT
Bây giờ trong khung chat của ChatGPT, bạn có thể ra lệnh trực tiếp:
* *"Hãy kiểm tra các tiến trình đang chiếm nhiều RAM nhất trên máy tính của tôi"*
* *"Đọc nội dung file D:\Projects\README.md và tóm tắt lại"*
* *"Tạo một file test.py và chạy thử"*

---

### Phương thức 2: Dùng ChatGPT theo kiểu Plugin truyền thống (Custom GPT Actions / OpenAPI)

Nếu bạn muốn sử dụng giao diện gọi công cụ giống hệt **ChatGPT Plugins** trước đây (hiển thị nút bấm xác nhận, gọi API trực tiếp theo chuẩn OpenAPI):

OpenAI đã thay thế Plugins cũ bằng cơ chế **Custom GPTs Actions**. Bạn có thể tạo một GPT riêng chỉ trong 2 phút:

#### Bước 1: Mở cổng public HTTPS an toàn bằng Cloudflare hoặc ngrok
Custom GPTs của OpenAI yêu cầu endpoint phải có giao thức `https://`. Bạn có thể dùng 1 trong 2 công cụ miễn phí sau:
* **Cách A - ngrok:**
  ```bash
  ngrok http 8787
  ```
  *(Bạn nhận được URL dạng: `https://xxxx-xx-xx.ngrok-free.app`)*
* **Cách B - Cloudflare Tunnel (Miễn phí, không giới hạn):**
  ```bash
  cloudflared tunnel --url http://127.0.0.1:8787
  ```
  *(Bạn nhận được URL dạng: `https://xxxx-xx-xx.trycloudflare.com`)*

#### Bước 2: Tạo Custom GPT
1. Truy cập [GPT Builder](https://chatgpt.com/gpts/editor) (dành cho tài khoản Plus, Team, Enterprise).
2. Vào tab **Configure**:
   * **Name:** `Desktop Commander`
   * **Description:** `Trợ lý điều khiển và quản lý máy tính cá nhân an toàn.`
   * **Instructions:**
     ```text
     Bạn là trợ lý điều khiển máy tính cá nhân thông qua Desktop Commander Manager.
     Khi người dùng yêu cầu chạy lệnh, đọc/ghi file hoặc kiểm tra hệ thống, hãy sử dụng các Action tương ứng.
     Luôn xác nhận trước khi thực hiện các lệnh nguy hiểm.
     ```
3. Kéo xuống mục **Actions**, nhấn **Create new action**.
4. Ở ô **Schema**, sao chép và dán toàn bộ nội dung từ file:
   👉 [`docs/chatgpt-openapi-schema.json`](docs/chatgpt-openapi-schema.json)
5. Trong nội dung vừa dán, thay thế `"https://YOUR_TUNNEL_URL"` ở phần `servers` bằng URL HTTPS bạn nhận được ở Bước 1 (ví dụ: `https://xxxx.trycloudflare.com`).
6. Mục **Authentication**: Chọn **None** (nếu chạy nội bộ) hoặc **API Key**.

#### Bước 3: Lưu và bắt đầu sử dụng
1. Nhấn **Save** ở góc trên bên phải (chọn *Only me* để sử dụng riêng tư).
2. Mở cuộc trò chuyện với GPT vừa tạo: Mỗi khi bạn ra lệnh, ChatGPT sẽ hiển thị thông báo gọi Plugin/Action và gửi yêu cầu trực tiếp về máy bạn!

---

### Phương thức 3: Kết nối với Claude Desktop / Cursor / Windsurf / MCP Inspector

Nếu bạn muốn sử dụng đồng thời với Claude Desktop hoặc các IDE hỗ trợ MCP:

Mở file cấu hình `claude_desktop_config.json` (tại `%APPDATA%\Claude\claude_desktop_config.json` trên Windows hoặc `~/.config/Claude/claude_desktop_config.json` trên Linux):

```json
{
  "mcpServers": {
    "desktop-commander": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

---

## 🖥️ Chạy từ mã nguồn (Dành cho Developer)

### Yêu cầu môi trường
* Windows 10/11 hoặc Ubuntu 20.04+
* Node.js 22+ & npm
* Rust 1.80+ (với `cargo`)

### Cài đặt và khởi chạy

```bash
# Cài đặt dependencies và build dashboard
npm install
npm run build

# Biên dịch mã nguồn Rust Release
npm run build:rust

# Chạy Manager
npm run dev
```

Sau khi khởi động thành công:
* **Web Dashboard:** `http://127.0.0.1:8788/`
* **MCP Router Endpoint:** `http://127.0.0.1:8787/mcp`

### Cài đặt tự khởi động (Autostart)
* **Windows:** Click đúp `install-autostart.bat` (tự động tạo Windows Task Scheduler hoặc HKCU Run key, không đòi quyền Administrator). Gỡ bỏ: `uninstall-autostart.bat`.
* **Linux / Ubuntu:** Chạy `scripts/package-release.sh` rồi chạy `./install-service.sh` để đăng ký systemd user service.

---

## 🔧 Kiểm thử và xác thực (Testing & Benchmarks)

Dự án có hệ thống kiểm thử tự động toàn diện:

```bash
# Kiểm thử toàn bộ TypeScript & Vitest
npm test

# Kiểm thử hợp đồng giao tiếp (Contract tests)
npm run test:contracts

# Kiểm thử khả năng tự phục hồi và Rollback
npm run test:recovery

# Kiểm thử toàn bộ workspace Rust
npm run test:rust

# Kiểm tra code style & linting Rust
npm run lint:rust

# Chạy đo lường hiệu năng M6 (Stop-condition review benchmark)
npm run benchmark:m6
```

---

## 🛡️ Bảo mật & Cô lập

- **Không lưu trữ Secret trong mã nguồn:** Toàn bộ API keys của Tunnel được lưu ngoài repo với quyền truy cập hạn chế theo người dùng OS.
- **Cách ly worker:** Mỗi worker chạy với thư mục runtime, biến môi trường (`USERPROFILE`, `HOME`, `TEMP`) riêng biệt.
- **An toàn khi lỗi:** Khi xảy ra lỗi mất kết nối giữa chừng, Manager trả về lỗi MCP an toàn chứ không tự ý replay những lệnh gây đột biến hệ thống (mutating operations).

---

## 📄 Giấy phép

Phát hành theo giấy phép [MIT](LICENSE).
