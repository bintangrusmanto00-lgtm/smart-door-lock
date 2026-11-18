'use strict';

/* ===== Data simulasi (bukan data biometrik asli) ===== */
let USERS = { 1: 'Bintang', 2: 'Galang', 3: 'Lutfi', 4: 'Raply', 5: 'Revania' };
const SCAN_MS = 1800;
const VERIFY_MS = 700;

/* ===== Variabel sistem ===== */
let systemStatus;      // Standby | Scanning | Verifying | Error
let sensorStatus;      // Ready | Scanning | Success | Failed
let fingerprintID;     // Integer / null
let userName;          // String
let accessGranted;     // Boolean
let doorStatus;        // Locked | Unlocking | Open | Locking
let lockStatus;        // true = pengunci aktif (terkunci)
let solenoidStatus;    // true = solenoid dialiri arus (baut tertarik, pintu bisa dibuka)
let scanDuration;      // ms
let lastAccessTime;    // String
let successfulAccess;  // Integer
let failedAccess;      // Integer
let accessLogs;        // Array
let doorOpenDuration;  // ms
let autoLockEnabled;   // Boolean

/* variabel bantu */
let authKnown = false; // true setelah ada hasil autentikasi pada pemindaian terakhir
let runId = 0;         // pembatal proses yang sedang berjalan saat reset
let lockBusy = false;
let hwConnected = false; // true bila Arduino tersambung lewat Web Serial (lihat serial.js)

/* DFPlayer Mini (simulasi) */
const TRACKS = { 1: { file: '0001.mp3', text: 'Silakan masuk' }, 2: { file: '0002.mp3', text: 'Coba lagi' } };
let dfStatus = 'Idle'; // Idle | Playing
let dfVolume = 20;     // 0 - 30, sama seperti DFPlayer asli
let voiceId = 0;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chip(el, text, tone) { el.textContent = text; el.dataset.tone = tone; }

/* ===== Tampilan ===== */
function isIdle() {
  return systemStatus === 'Standby' && doorStatus === 'Locked' && sensorStatus === 'Ready';
}

function render() {
  const err = systemStatus === 'Error';
  chip($('stArduino'), err ? 'Offline' : hwConnected ? 'Connected' : 'Simulated', err ? 'bad' : hwConnected ? 'ok' : 'idle');
  chip($('stSensor'), sensorStatus, { Ready: 'idle', Scanning: 'proc', Success: 'ok', Failed: 'bad' }[sensorStatus]);
  chip($('stAuth'), authKnown ? (accessGranted ? 'Granted' : 'Denied') : 'Menunggu',
       authKnown ? (accessGranted ? 'ok' : 'bad') : 'idle');
  const doorTone = { Locked: 'idle', Unlocking: 'proc', Open: 'ok', Locking: 'proc' }[doorStatus];
  chip($('stDoor'), doorStatus, doorTone);
  chip($('doorState'), doorStatus, doorTone);
  chip($('stLock'), lockStatus ? 'Locked' : 'Unlocked', lockStatus ? 'idle' : 'ok');
  chip($('navStatus'), systemStatus,
       { Standby: 'idle', Scanning: 'proc', Verifying: 'proc', Error: 'bad' }[systemStatus]);
  $('statOk').textContent = successfulAccess;
  $('statFail').textContent = failedAccess;

  $('door').dataset.state = doorStatus.toLowerCase();
  $('bolt').dataset.locked = lockStatus;
  $('solState').textContent = solenoidStatus
    ? 'Solenoid: aktif / energized (baut tertarik)'
    : 'Solenoid: tidak aktif (baut terkunci)';
  $('sensor').dataset.tone = { Ready: 'idle', Scanning: 'proc', Success: 'ok', Failed: 'bad' }[sensorStatus];

  const canEdit = isIdle() || err;
  $('btnScan').disabled = !isIdle();
  $('btnLock').disabled = !(doorStatus === 'Open' && !autoLockEnabled && !lockBusy);
  $('optAuto').disabled = !canEdit;
  $('optDuration').disabled = !canEdit;
  $('optError').disabled = !canEdit;
}

function showResult(tone, title, detail) {
  $('result').dataset.tone = tone;
  $('resTitle').textContent = title;
  $('resDetail').textContent = detail;
}

function leds(mode) {
  // Sinkronkan LED pada diagram perangkat dan indikator kecil di dashboard.
  $('ledG').classList.toggle('on', mode === 'g');
  $('ledR').classList.toggle('on', mode === 'r');
  $('dashLedGreen').classList.toggle('on', mode === 'g');
  $('dashLedRed').classList.toggle('on', mode === 'r');
  $('dashLedGreen').setAttribute('aria-label', mode === 'g' ? 'LED hijau menyala' : 'LED hijau mati');
  $('dashLedRed').setAttribute('aria-label', mode === 'r' ? 'LED merah menyala' : 'LED merah mati');
  $('ledCaption').textContent = mode === 'g'
    ? 'LED hijau menyala · akses / operasi berhasil'
    : mode === 'r'
      ? 'LED merah menyala · akses / operasi gagal'
      : 'Kedua LED mati · sistem siaga';
}

function renderLog() {
  const body = $('logBody');
  body.textContent = '';
  if (accessLogs.length === 0) {
    const tr = body.insertRow();
    const td = tr.insertCell();
    td.colSpan = 6; td.className = 'empty';
    td.textContent = 'Belum ada aktivitas. Jalankan pemindaian di panel Simulasi.';
    return;
  }
  accessLogs.forEach((l) => {
    const tr = body.insertRow();
    [l.no, l.time, l.id, l.name, l.result, l.door].forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v;
      if (i === 4) td.className = l.granted ? 'ok' : 'bad';
    });
  });
}

function addLog() {
  accessLogs.push({
    no: accessLogs.length + 1,
    time: lastAccessTime,
    id: fingerprintID === null ? '-' : fingerprintID,
    name: userName,
    result: accessGranted ? 'Granted' : 'Denied',
    granted: accessGranted,
    door: doorStatus + ' / ' + (lockStatus ? 'Locked' : 'Unlocked')
  });
  renderLog();
}

/* ===== LCD 16x2 virtual ===== */
function lcdLine(el, text) {
  el.textContent = '';
  const s = String(text || '').toUpperCase();
  for (let i = 0; i < 16; i++) {
    const c = document.createElement('span');
    c.textContent = s[i] || '\u00a0';
    el.appendChild(c);
  }
}

function lcd(line1, line2) {
  lcdLine($('lcd1'), line1);
  lcdLine($('lcd2'), line2);
}

function lcdIdle() {
  if (systemStatus === 'Error') lcd('SISTEM ERROR', 'CEK PERANGKAT');
  else lcd('SILAKAN SCAN', 'JARI ANDA');
}

/* ===== DFPlayer Mini (suara disimulasikan dengan text-to-speech browser) ===== */
function renderDF() {
  chip($('dfState'), dfStatus, dfStatus === 'Playing' ? 'proc' : 'idle');
  $('eq').classList.toggle('playing', dfStatus === 'Playing');
}

function stopVoice() {
  voiceId++;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  dfStatus = 'Idle';
  renderDF();
}

function playTrack(n, tone) {
  const t = TRACKS[n];
  const id = ++voiceId;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  dfStatus = 'Playing';
  $('dfCaption').textContent = 'Track ' + t.file + ' · "' + t.text + '"';
  $('dfCaption').dataset.tone = tone;
  renderDF();
  const done = () => { if (id === voiceId) { dfStatus = 'Idle'; renderDF(); } };
  if ($('dfMute').checked || !('speechSynthesis' in window)) {
    setTimeout(done, 1500);
    return;
  }
  const u = new SpeechSynthesisUtterance(t.text);
  u.lang = 'id-ID';
  u.volume = dfVolume / 30;
  const v = window.speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith('id'));
  if (v) u.voice = v;
  u.onend = done;
  u.onerror = done;
  window.speechSynthesis.speak(u);
}

/* ===== Logika sistem ===== */
function resetVars() {
  systemStatus = $('optError').checked ? 'Error' : 'Standby';
  sensorStatus = 'Ready';
  fingerprintID = null;
  userName = '-';
  accessGranted = false;
  doorStatus = 'Locked';
  lockStatus = true;
  solenoidStatus = false;
  scanDuration = SCAN_MS;
  lastAccessTime = '-';
  successfulAccess = 0;
  failedAccess = 0;
  accessLogs = [];
  doorOpenDuration = Number($('optDuration').value) * 1000;
  autoLockEnabled = $('optAuto').checked;
  authKnown = false;
  lockBusy = false;
}

async function lockDoor(id) {
  lockBusy = true;
  render();
  // Pengunci tidak boleh aktif selama pintu masih ditahan terbuka
  while ($('optHold').checked) {
    lcd('PINTU DITAHAN', 'LEPAS HALANGAN');
    showResult('proc', 'Penguncian ditunda', 'Pintu masih ditahan terbuka. Lepaskan halangan agar pintu bisa terkunci.');
    await sleep(300);
    if (id !== runId) return;
  }
  doorStatus = 'Locking';
  lcd('MENGUNCI...', '');
  render();
  await sleep(800);
  if (id !== runId) return;
  doorStatus = 'Locked';
  lockStatus = true;
  solenoidStatus = false;
  sensorStatus = 'Ready';
  lockBusy = false;
  leds();
  showResult('idle', 'Pintu terkunci', 'Sistem kembali siaga.');
  lcdIdle();
  render();
}

async function scan(hw) { // hw = {valid, uid} dari Arduino; tanpa argumen = simulasi
  if (!isIdle()) return;
  const id = ++runId;
  const valid = hw ? hw.valid : document.querySelector('input[name=fp]:checked').value === 'valid';
  const uid = hw ? hw.uid : Number($('selUser').value);
  doorOpenDuration = Number($('optDuration').value) * 1000;
  autoLockEnabled = $('optAuto').checked;

  systemStatus = 'Scanning';
  sensorStatus = 'Scanning';
  authKnown = false;
  accessGranted = false;
  fingerprintID = null;
  userName = '-';
  leds();
  $('sensor').classList.add('scanning');
  showResult('proc', 'Memindai sidik jari...', 'Tahan jari pada sensor.');
  lcd('MEMINDAI...', 'TAHAN JARI');
  render();
  await sleep(hw ? 0 : scanDuration);
  if (id !== runId) return;

  systemStatus = 'Verifying';
  showResult('proc', 'Memverifikasi...', 'Mencocokkan dengan template tersimpan.');
  lcd('MEMVERIFIKASI', 'MOHON TUNGGU');
  render();
  await sleep(hw ? 0 : VERIFY_MS);
  if (id !== runId) return;

  $('sensor').classList.remove('scanning');
  lastAccessTime = new Date().toLocaleString('id-ID');
  systemStatus = 'Standby';
  authKnown = true;

  if (valid) {
    accessGranted = true;
    fingerprintID = uid;
    userName = USERS[uid] || ('ID ' + uid);
    sensorStatus = 'Success';
    successfulAccess++;
    lockStatus = false;
    solenoidStatus = true;
    doorStatus = 'Unlocking';
    leds('g');
    showResult('ok', 'Access Granted', 'ID ' + uid + ' · ' + userName);
    playTrack(1, 'ok');
    lcd('AKSES DITERIMA', 'HALO, ' + userName);
    addLog();
    render();
    await sleep(700);
    if (id !== runId) return;
    doorStatus = 'Open';
    render();
    const total = doorOpenDuration / 1000;
    for (let left = total; left > 0; left--) {
      if (left !== total) lcd('PINTU TERBUKA', autoLockEnabled ? 'TUTUP DLM ' + left + ' DTK' : 'TEKAN KUNCI');
      await sleep(1000);
      if (id !== runId) return;
    }
    if (autoLockEnabled) await lockDoor(id);
    else {
      showResult('ok', 'Pintu terbuka', 'Auto Lock nonaktif. Tekan Kunci Pintu untuk mengunci.');
      lcd('PINTU TERBUKA', 'TEKAN KUNCI');
    }
    render();
  } else {
    accessGranted = false;
    sensorStatus = 'Failed';
    failedAccess++;
    leds('r');
    showResult('bad', 'Access Denied', 'Sidik jari tidak terdaftar. Pintu tetap terkunci.');
    playTrack(2, 'bad');
    lcd('COBA LAGI', 'JARI TDK DIKENAL');
    addLog();
    render();
    await sleep(1800);
    if (id !== runId) return;
    sensorStatus = 'Ready';
    leds();
    lcdIdle();
    showResult('idle', 'Siap memindai', 'Pilih skenario, lalu tekan Scan Fingerprint.');
    render();
  }
}

function resetSystem() {
  runId++;
  stopVoice();
  $('dfCaption').textContent = 'Menunggu perintah putar suara.';
  $('dfCaption').dataset.tone = 'idle';
  $('dfMute').checked = false;
  $('dfVol').value = '20';
  dfVolume = 20;
  $('dfVolVal').textContent = '20';
  $('optAuto').checked = true;
  $('optHold').checked = false;
  $('optError').checked = false;
  $('optDuration').value = '5';
  $('sensor').classList.remove('scanning');
  resetVars();
  leds();
  lcdIdle();
  showResult('idle', 'Siap memindai', 'Pilih skenario, lalu tekan Scan Fingerprint.');
  renderLog();
  render();
}

/* ===== Event ===== */
$('btnScan').addEventListener('click', () => scan());
$('btnReset').addEventListener('click', resetSystem);
$('btnLock').addEventListener('click', () => {
  if (doorStatus === 'Open' && !lockBusy) lockDoor(++runId);
});
$('btnClear').addEventListener('click', () => {
  if (accessLogs.length === 0) return;
  if (confirm('Hapus seluruh riwayat log aktivitas?')) {
    accessLogs = [];
    renderLog();
  }
});
$('btnStart').addEventListener('click', () => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('simulasi').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  $('btnScan').focus({ preventScroll: true });
});
$('optAuto').addEventListener('change', (e) => { autoLockEnabled = e.target.checked; });
$('optError').addEventListener('change', (e) => {
  if (e.target.checked) {
    systemStatus = 'Error';
    leds('r');
    showResult('bad', 'Peringatan: sistem error', 'Tidak ada akses baru yang diberikan sampai error dihapus.');
    lcdIdle();
  } else {
    systemStatus = 'Standby';
    leds();
    lcdIdle();
    showResult('idle', 'Siap memindai', 'Pilih skenario, lalu tekan Scan Fingerprint.');
  }
  render();
});

$('btnTrack1').addEventListener('click', () => playTrack(1, 'ok'));
$('btnTrack2').addEventListener('click', () => playTrack(2, 'bad'));
$('dfVol').addEventListener('input', (e) => {
  dfVolume = Number(e.target.value);
  $('dfVolVal').textContent = dfVolume;
});
if ('speechSynthesis' in window) window.speechSynthesis.getVoices();


/* ===== Manajemen fingerprint FPM10A (simulasi browser) ===== */
function fpMessage(tone, title, detail) {
  $('fpResult').dataset.tone = tone;
  $('fpResTitle').textContent = title;
  $('fpResDetail').textContent = detail;
  if (tone === 'ok') leds('g');
  else if (tone === 'bad') leds('r');
  else leds();
}
function renderFpUsers() {
  const body = $('fpUsersBody');
  body.textContent = '';
  Object.keys(USERS).map(Number).sort((a,b)=>a-b).forEach((id) => {
    const tr = body.insertRow();
    [id, USERS[id], 'Terdaftar'].forEach((v) => { tr.insertCell().textContent = v; });
  });
  if (!Object.keys(USERS).length) {
    const tr = body.insertRow(), td = tr.insertCell();
    td.colSpan = 3; td.className = 'empty'; td.textContent = 'Belum ada sidik jari terdaftar.';
  }
  $('fpCount').textContent = Object.keys(USERS).length + ' template tersimpan di simulasi.';
  const select = $('selUser');
  const current = select.value;
  select.textContent = '';
  Object.keys(USERS).map(Number).sort((a,b)=>a-b).forEach(id => {
    const opt = document.createElement('option');
    opt.value = String(id); opt.textContent = 'ID ' + id + ' · ' + USERS[id];
    select.appendChild(opt);
  });
  if (USERS[current]) select.value = current;
}
function fpInput() {
  const id = Number($('fpId').value);
  const name = $('fpName').value.trim();
  if (!Number.isInteger(id) || id < 1 || id > 127) {
    fpMessage('bad', 'ID tidak valid', 'Gunakan ID bilangan bulat dari 1 sampai 127.');
    return null;
  }
  return {id, name};
}
$('btnEnroll').addEventListener('click', () => {
  const v = fpInput(); if (!v) return;
  if (!v.name) { fpMessage('bad', 'Nama wajib diisi', 'Masukkan nama untuk template fingerprint ini.'); return; }
  if (USERS[v.id]) { fpMessage('bad', 'ID sudah digunakan', 'Gunakan ID lain atau hapus ID tersebut terlebih dahulu.'); return; }
  USERS[v.id] = v.name;
  renderFpUsers();
  fpMessage('ok', 'Enrollment berhasil', 'Simulasi: jari dipindai dua kali dan template disimpan pada ID ' + v.id + '.');
});
$('btnVerify').addEventListener('click', () => {
  const v = fpInput(); if (!v) return;
  if (USERS[v.id]) {
    fpMessage('ok', 'Verification berhasil', 'Cocok dengan ID ' + v.id + ' · ' + USERS[v.id] + '. LED hijau dan buzzer berbunyi pendek.');
  } else {
    fpMessage('bad', 'Verification gagal', 'Template tidak ditemukan. LED merah dan buzzer berbunyi panjang.');
  }
});
$('btnDelete').addEventListener('click', () => {
  const v = fpInput(); if (!v) return;
  if (!USERS[v.id]) { fpMessage('bad', 'ID tidak ditemukan', 'Tidak ada template tersimpan dengan ID ' + v.id + '.'); return; }
  const name = USERS[v.id];
  delete USERS[v.id];
  renderFpUsers();
  fpMessage('ok', 'Delete berhasil', 'Template milik ' + name + ' pada ID ' + v.id + ' dihapus dari simulasi.');
});
renderFpUsers();

resetSystem();
