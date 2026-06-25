'use strict';

const input    = document.getElementById('folderInput');
const statusEl = document.getElementById('status');
const selectBtn = document.getElementById('selectBtn');

selectBtn.addEventListener('click', () => input.click());

input.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) {
    window.close();
    return;
  }

  selectBtn.disabled = true;
  selectBtn.style.opacity = '0.5';
  statusEl.className = 'status progress-text';
  statusEl.textContent = `正在读取 ${files.length} 个文件...`;

  try {
    const fileDataList = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const buffer = await file.arrayBuffer();
      fileDataList.push({
        name:   file.name,
        path:   file.webkitRelativePath,
        type:   file.type,
        size:   file.size,
        lastModified: file.lastModified,
        buffer
      });

      if (i % 20 === 0 || i === files.length - 1) {
        statusEl.textContent = `正在读取文件... ${i + 1}/${files.length}`;
      }
    }

    statusEl.textContent = '正在传输数据...';

    const bc = new BroadcastChannel('folder-picker-channel');
    const CHUNK = 20;

    for (let i = 0; i < fileDataList.length; i += CHUNK) {
      bc.postMessage({
        type:  'FOLDER_CHUNK',
        files: fileDataList.slice(i, i + CHUNK)
      });
    }

    bc.postMessage({ type: 'FOLDER_DONE', totalFiles: fileDataList.length });
    bc.close();

    statusEl.className = 'status success-text';
    statusEl.textContent = `✅ 已传输 ${fileDataList.length} 个文件，窗口即将关闭...`;
    setTimeout(() => window.close(), 600);

  } catch (err) {
    statusEl.className = 'status error-text';
    statusEl.textContent = '❌ 读取失败：' + err.message;
    selectBtn.disabled = false;
    selectBtn.style.opacity = '1';
  }
});
