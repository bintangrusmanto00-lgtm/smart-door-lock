'use strict';

/* ===== Web Serial: hubungkan website ke Arduino Uno + FPM10A =====
   Dimuat setelah script.js. Butuh Chrome/Edge dan localhost atau HTTPS.
   Protokol pesan ada di README-Arduino.txt. */
(() => {
  const BAUD = 9600;
  const btn = $('btnConnect');
  let port = null, reader = null, writer = null;
  let pendingName = '';

  function setButton() {
    btn.textContent = hwConnected ? 'Putuskan Arduino' : 'Hubungkan Arduino';
    btn.classList.toggle('live', hwConnected);
  }

  async function send(text) {
    if (!writer) return;
    await writer.write(new TextEncoder().encode(text + '\n'));
  }

  /* Hasil dari sensor asli adalah acuan: batalkan animasi simulasi yang masih berjalan */
  function startHwScan(hw) {
    if (systemStatus === 'Error') return;
    if (!isIdle()) {
      runId++;
      systemStatus = 'Standby'; sensorStatus = 'Ready'; doorStatus = 'Locked';
      lockStatus = true; solenoidStatus = false; lockBusy = false;
      $('sensor').classList.remove('scanning');
    }
    scan(hw);
  }

  /* ---- pesan dari Arduino ---- */
  function onLine(line) {
    if (!line) return;
    const i = line.indexOf(':');
    const type = i < 0 ? line : line.slice(0, i);
    const arg = i < 0 ? '' : line.slice(i + 1);
    const id = Number(arg);

    switch (type) {
      case 'VALID':
        startHwScan({ valid: true, uid: id });
        break;
      case 'INVALID':
        startHwScan({ valid: false });
        break;
      case 'ENROLL_OK':
        USERS[id] = pendingName || ('ID ' + id);
        renderFpUsers();
        fpMessage('ok', 'Enrollment berhasil', 'Template tersimpan di sensor pada ID ' + id + ' · ' + USERS[id] + '.');
        break;
      case 'ENROLL_FAIL':
        fpMessage('bad', 'Enrollment gagal', 'Jari tidak terbaca atau dua pemindaian tidak cocok. Coba lagi.');
        break;
      case 'DELETE_OK':
        delete USERS[id];
        renderFpUsers();
        fpMessage('ok', 'Delete berhasil', 'Template pada ID ' + id + ' dihapus dari sensor.');
        break;
      case 'DELETE_FAIL':
        fpMessage('bad', 'Delete gagal', 'ID tidak ditemukan di sensor.');
        break;
      case 'READY':
        showResult('ok', 'Arduino siap', 'Tempelkan jari pada sensor FPM10A.');
        break;
      case 'MSG':
        fpMessage('proc', 'Sensor FPM10A', arg);
        break;
      default:
        console.log('[Arduino]', line);
    }
  }

  async function readLoop() {
    const dec = new TextDecoder();
    let buf = '';
    try {
      reader = port.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let n;
        while ((n = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, n).trim());
          buf = buf.slice(n + 1);
        }
      }
    } catch (e) {
      /* kabel dicabut atau port ditutup */
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }
    await cleanup();
  }

  async function cleanup() {
    try { writer && writer.releaseLock(); } catch (e) {}
    try { port && await port.close(); } catch (e) {}
    port = reader = writer = null;
    hwConnected = false;
    setButton();
    showResult('idle', 'Arduino terputus', 'Kembali ke mode simulasi.');
    render();
  }

  /* ---- sambung / putus ---- */
  async function connect() {
    if (!('serial' in navigator)) {
      alert('Browser ini belum mendukung Web Serial. Gunakan Chrome atau Edge di laptop, dan buka lewat localhost atau HTTPS.');
      return;
    }
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD });
    } catch (e) {
      port = null;
      if (e.name !== 'NotFoundError') {
        alert('Gagal membuka port: ' + e.message + '\nPastikan Serial Monitor Arduino IDE sudah ditutup.');
      }
      return;
    }
    writer = port.writable.getWriter();
    hwConnected = true;
    setButton();
    showResult('ok', 'Arduino terhubung', 'Letakkan jari pada sensor FPM10A. Hasilnya akan tampil di sini.');
    render();
    readLoop();
  }

  async function disconnect() {
    try { if (reader) await reader.cancel(); } catch (e) {}
  }

  btn.addEventListener('click', () => (hwConnected ? disconnect() : connect()));

  /* ---- tombol panel Fingerprint: kirim perintah ke sensor saat terhubung ---- */
  $('kelola').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const cmd = b && { btnEnroll: 'ENROLL', btnVerify: 'VERIFY', btnDelete: 'DELETE' }[b.id];
    if (!hwConnected || !cmd) return;
    e.stopPropagation(); // cegah handler simulasi di script.js

    if (cmd === 'VERIFY') {
      fpMessage('proc', 'Verification', 'Tempelkan jari pada sensor. Hasilnya tampil sebagai akses di panel Simulasi dan Log Aktivitas.');
      return;
    }
    const v = fpInput();
    if (!v) return;
    if (cmd === 'ENROLL') {
      if (!v.name) { fpMessage('bad', 'Nama wajib diisi', 'Masukkan nama untuk template fingerprint ini.'); return; }
      if (USERS[v.id]) { fpMessage('bad', 'ID sudah digunakan', 'Gunakan ID lain atau hapus ID tersebut terlebih dahulu.'); return; }
      pendingName = v.name;
      fpMessage('proc', 'Enrollment ID ' + v.id, 'Ikuti petunjuk: tempelkan jari dua kali pada sensor.');
    } else {
      fpMessage('proc', 'Delete ID ' + v.id, 'Menghapus template dari sensor...');
    }
    // Sketch memakai menu 'e' / 'd' lalu membaca angka ID, jadi cukup kirim mis. "e6"
    send((cmd === 'ENROLL' ? 'e' : 'd') + v.id);
  }, true);

  setButton();
})();
