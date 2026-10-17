# Travel Suite

He thong chia se thong tin du lich: **guide** dang dia diem, anh, thong tin; **traveler** tim kiem, danh gia va binh luan.
Web service (REST API, JSON) dung chung cho web, smartphone va tablet. Web client la 1 trang responsive trong `public/index.html`.

## Cong nghe
- Node.js >= 22.13 (chi dung module co san: `http`, `node:sqlite`, `crypto`; **khong can `npm install`**)
- SQLite (file `data.db`, tu tao khi chay lan dau); anh luu trong thu muc `uploads/`

## Chay
```
node server.js          # mac dinh cong 3000, doi bang bien moi truong PORT
```
Mo http://localhost:3000. Chay test tu dong (23 test cho 6 user story): `node test.js`

## User story da lam
| Story | Chuc nang |
|---|---|
| Dang ky | `POST /api/auth/register` (mat khau hash scrypt, kiem tra trung username/email) |
| Login / logout / bao ve tai nguyen | `POST /api/auth/login`, `POST /api/auth/logout`, token Bearer luu trong bang `sessions`; sua/xoa chi cho chu so huu |
| Guide them place | `POST /api/places` |
| Guide CRUD anh, thong tin | `POST/PUT/DELETE` tren `/api/places/:id`, `/api/images/:id`, `/api/infos/:id` |
| Traveler tim kiem | `GET /api/search?q=` (place, anh, thong tin) |
| Traveler danh gia + binh luan | `POST/GET /api/images/:id/reviews`, `/api/infos/:id/reviews` (1-5 sao) |

Upload anh: `POST /api/places/:id/images?caption=...` voi body la file anh (jpg/png/gif/webp, toi da 5 MB).

## Deploy len server rieng (Linux)
```
# cai Node 22+ (https://nodejs.org), roi:
git clone https://github.com/binhkieu68/asm-travel-suite.git
cd asm-travel-suite
PORT=80 node server.js          # chay thu
```
Chay nen lau dai bang pm2: `npm i -g pm2 && pm2 start server.js --name travel && pm2 save && pm2 startup`.
Nho mo cong (firewall / security group) cho cong dang dung. Windows: cai Node roi `node server.js`.

Demo: http://<dia-chi-server>:3000
