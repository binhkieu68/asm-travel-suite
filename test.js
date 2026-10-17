'use strict';
// Chay: npm test   (dung DB trong bo nho + thu muc anh tam, khong dong vao du lieu that)
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.DB_FILE = ':memory:';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-'));
const server = require('./server');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  let passed = 0;

  async function call(method, url, { token, json, body, type } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (type) headers['Content-Type'] = type;
    const r = await fetch(base + url, { method, headers, body });
    return { status: r.status, data: await r.json().catch(() => null) };
  }
  async function test(name, fn) {
    try { await fn(); passed++; console.log('  OK   ' + name); }
    catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
  }
  const register = (u, role) => call('POST', '/api/auth/register', { json: { username: u, email: u + '@x.com', password: 'secret1', role } });
  const login = async (u) => (await call('POST', '/api/auth/login', { json: { username: u, password: 'secret1' } })).data.token;

  console.log('US6 - Dang ky');
  await test('dang ky guide va traveler thanh cong', async () => {
    assert.equal((await register('guideA', 'GUIDE')).status, 201);
    assert.equal((await register('guideB', 'GUIDE')).status, 201);
    assert.equal((await register('tourist', 'TRAVELER')).status, 201);
  });
  await test('trung username bao 409', async () => assert.equal((await register('GUIDEA', 'GUIDE')).status, 409));
  await test('mat khau ngan / email sai / role sai bao 400', async () => {
    assert.equal((await call('POST', '/api/auth/register', { json: { username: 'abc', email: 'a@b.co', password: '123', role: 'GUIDE' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { json: { username: 'abc', email: 'sai', password: '123456', role: 'GUIDE' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { json: { username: 'abc', email: 'a@b.co', password: '123456', role: 'ADMIN' } })).status, 400);
  });

  console.log('US1 - Dang nhap / dang xuat / bao ve tai nguyen');
  const gA = await login('guideA'), gB = await login('guideB'), tr = await login('tourist');
  await test('sai mat khau bao 401', async () =>
    assert.equal((await call('POST', '/api/auth/login', { json: { username: 'guideA', password: 'sai' } })).status, 401));
  await test('khong co token bao 401', async () =>
    assert.equal((await call('POST', '/api/places', { json: { name: 'X' } })).status, 401));
  await test('traveler khong them duoc place (403)', async () =>
    assert.equal((await call('POST', '/api/places', { token: tr, json: { name: 'X' } })).status, 403));
  await test('logout vo hieu hoa token', async () => {
    const t = await login('tourist');
    assert.equal((await call('GET', '/api/me', { token: t })).status, 200);
    assert.equal((await call('POST', '/api/auth/logout', { token: t })).status, 200);
    assert.equal((await call('GET', '/api/me', { token: t })).status, 401);
  });

  console.log('US2 - Guide them place');
  let placeId;
  await test('guide them place', async () => {
    const r = await call('POST', '/api/places', { token: gA, json: { name: 'Vinh Ha Long', location: 'Quang Ninh', description: 'Di san the gioi' } });
    assert.equal(r.status, 201); placeId = r.data.id;
  });
  await test('thieu ten bao 400', async () =>
    assert.equal((await call('POST', '/api/places', { token: gA, json: { name: '  ' } })).status, 400));

  console.log('US3 - Guide CRUD anh va thong tin');
  let imgId, infoId;
  await test('upload anh hop le', async () => {
    const r = await call('POST', `/api/places/${placeId}/images?caption=${encodeURIComponent('Hoang hon')}`, { token: gA, body: PNG, type: 'image/png' });
    assert.equal(r.status, 201); imgId = r.data.id;
    assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, r.data.file_path)));
  });
  await test('file khong phai anh bi tu choi (400)', async () =>
    assert.equal((await call('POST', `/api/places/${placeId}/images`, { token: gA, body: Buffer.from('MZ-not-an-image-at-all'), type: 'image/png' })).status, 400));
  await test('guide khac khong upload / sua / xoa duoc (403)', async () => {
    assert.equal((await call('POST', `/api/places/${placeId}/images`, { token: gB, body: PNG, type: 'image/png' })).status, 403);
    assert.equal((await call('PUT', `/api/images/${imgId}`, { token: gB, json: { caption: 'hack' } })).status, 403);
    assert.equal((await call('DELETE', `/api/images/${imgId}`, { token: gB })).status, 403);
    assert.equal((await call('PUT', `/api/places/${placeId}`, { token: gB, json: { name: 'hack' } })).status, 403);
    assert.equal((await call('DELETE', `/api/places/${placeId}`, { token: gB })).status, 403);
  });
  await test('sua chu thich anh', async () => {
    assert.equal((await call('PUT', `/api/images/${imgId}`, { token: gA, json: { caption: 'Binh minh' } })).status, 200);
    assert.equal((await call('GET', `/api/places/${placeId}`)).data.images[0].caption, 'Binh minh');
  });
  await test('them / sua thong tin', async () => {
    const r = await call('POST', `/api/places/${placeId}/infos`, { token: gA, json: { title: 'Gia ve', content: 'Khoang 290.000 dong, chuyen di bang tau' } });
    assert.equal(r.status, 201); infoId = r.data.id;
    assert.equal((await call('PUT', `/api/infos/${infoId}`, { token: gA, json: { title: 'Gia ve 2026', content: 'Cap nhat gia' } })).status, 200);
    assert.equal((await call('GET', `/api/places/${placeId}`)).data.infos[0].title, 'Gia ve 2026');
  });

  console.log('US4 - Traveler tim kiem');
  await test('tim theo ten / dia diem / mo ta', async () => {
    assert.equal((await call('GET', '/api/search?q=long')).data.places.length, 1);
    assert.equal((await call('GET', '/api/search?q=Quang')).data.places.length, 1);
    assert.equal((await call('GET', '/api/search?q=the%20gioi')).data.places.length, 1);
  });
  await test('tim theo chu thich anh va noi dung thong tin', async () => {
    assert.equal((await call('GET', '/api/search?q=Binh%20minh')).data.images.length, 1);
    assert.equal((await call('GET', '/api/search?q=Cap%20nhat')).data.infos.length, 1);
  });
  await test('khong co ket qua -> mang rong; ky tu dac biet khong gay loi', async () => {
    const r = await call('GET', '/api/search?q=zzzzzz');
    assert.deepEqual([r.data.places.length, r.data.images.length, r.data.infos.length], [0, 0, 0]);
    assert.equal((await call('GET', "/api/search?q=%25'%3B--")).status, 200);
  });

  console.log('US5 - Traveler danh gia va binh luan');
  const trv = await login('tourist');
  await test('danh gia anh 5 sao + binh luan', async () => {
    assert.equal((await call('POST', `/api/images/${imgId}/reviews`, { token: trv, json: { rating: 5, comment: 'Dep qua' } })).status, 201);
    const p = (await call('GET', `/api/places/${placeId}`)).data;
    assert.equal(p.images[0].avg_rating, 5);
    assert.equal(p.images[0].review_count, 1);
  });
  await test('danh gia lai se cap nhat, khong tao them', async () => {
    assert.equal((await call('POST', `/api/images/${imgId}/reviews`, { token: trv, json: { rating: 3, comment: 'Binh thuong' } })).status, 200);
    const list = (await call('GET', `/api/images/${imgId}/reviews`)).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].rating, 3);
  });
  await test('danh gia thong tin', async () =>
    assert.equal((await call('POST', `/api/infos/${infoId}/reviews`, { token: trv, json: { rating: 4, comment: 'Huu ich' } })).status, 201));
  await test('rating 6 / 0 / chu bi tu choi (400)', async () => {
    for (const rating of [6, 0, 'abc'])
      assert.equal((await call('POST', `/api/images/${imgId}/reviews`, { token: trv, json: { rating } })).status, 400);
  });
  await test('guide khong danh gia duoc (403); chua dang nhap (401)', async () => {
    assert.equal((await call('POST', `/api/images/${imgId}/reviews`, { token: gA, json: { rating: 5 } })).status, 403);
    assert.equal((await call('POST', `/api/images/${imgId}/reviews`, { json: { rating: 5 } })).status, 401);
  });

  console.log('Xoa du lieu');
  await test('xoa place xoa luon anh, info, review va file anh', async () => {
    const file = (await call('GET', `/api/places/${placeId}`)).data.images[0].file_path;
    assert.equal((await call('DELETE', `/api/places/${placeId}`, { token: gA })).status, 200);
    assert.equal((await call('GET', `/api/places/${placeId}`)).status, 404);
    assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, file)), false);
    assert.equal((await call('GET', `/api/images/${imgId}/reviews`)).data.length, 0);
  });

  console.log(`\n${passed} test dat` + (process.exitCode ? ', CO LOI' : ', tat ca OK'));
  server.close();
}
main();
