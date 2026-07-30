const fs = require('fs');
const path = require('path');

async function uploadBook() {
  const filePath = path.resolve(__dirname, '../data/test-frankenstein.epub');
  const fileData = fs.readFileSync(filePath);

  // 1. Login to get the cookie
  const loginRes = await fetch('http://localhost:3001/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: 'endpaper' })
  });

  const cookies = loginRes.headers.get('set-cookie');
  if (!loginRes.ok) {
    console.error('Login failed', await loginRes.text());
    return;
  }

  // 2. Upload the file
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const crlf = '\r\n';
  
  const header = `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="test-frankenstein.epub"${crlf}Content-Type: application/epub+zip${crlf}${crlf}`;
  const footer = `${crlf}--${boundary}--${crlf}`;
  
  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileData,
    Buffer.from(footer, 'utf8')
  ]);

  const uploadRes = await fetch('http://localhost:3001/api/books', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Cookie': cookies
    },
    body: body
  });

  if (uploadRes.ok) {
    console.log('Upload successful!');
    console.log(await uploadRes.json());
  } else {
    console.error('Upload failed:', uploadRes.status, uploadRes.statusText);
    console.error(await uploadRes.text());
  }
}

uploadBook().catch(console.error);
