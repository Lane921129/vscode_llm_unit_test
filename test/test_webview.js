function acquireVsCodeApi(){return {postMessage:()=>null};}

        const vscode = acquireVsCodeApi();
        let currentKeys = {};

        window.onload = () => { 
            vscode.postMessage({ command: 'getInitialData' }); 
        };

        window.addEventListener('message', event => {
            const msg = event.data;
            switch(msg.command) {
                case 'setModels': 
                    document.getElementById('model-select').innerHTML = msg.models.map(m => \`<option value="\${m}">\${m}</option>\`).join(''); 
                    break;
                case 'setApiKeys':
                    currentKeys = msg.keys;
                    const keys = Object.keys(msg.keys);
                    document.getElementById('api-key-select').innerHTML = '<option value="">-- \u9078\u64C7 Key --</option>' + keys.map(k => \`<option value="\${k}">\${k}</option>\`).join('');
                    break;
                case 'setFiles': 
                    document.getElementById('file-select').innerHTML = '<option value="">-- \u9078\u64C7\u6A94\u6848 --</option>' + msg.files.map(f => \`<option value="\${f.path}">\${f.name}</option>\`).join(''); 
                    break;
                case 'setFunctions': 
                    document.getElementById('func-select').innerHTML = '<option value="">-- \u4E00\u9375\u6E2C\u8A66\u5168\u90E8 (\u6B64\u6A94\u6848) --</option>' + msg.funcs.map(f => \`<option value="\${f}">\${f}()</option>\`).join(''); 
                    break;
                case 'setProjectPath': 
                    document.getElementById('project-path').value = msg.path; 
                    break;
                case 'setOutputPath': 
                    document.getElementById('output-path').value = msg.path; 
                    break;
                case 'appendLog':
                    const log = document.getElementById('log-area');
                    log.value += (log.value ? '\\n' : '') + msg.text;
                    log.scrollTop = log.scrollHeight;
                    break;
                case 'updateCoverage':
                    const tbody = document.querySelector('#coverage-table tbody');
                    let existingRow = Array.from(tbody.querySelectorAll('tr')).find(row => row.cells[0]?.textContent === msg.fileName);
                    if (existingRow) {
                        existingRow.cells[1].innerHTML = \`<span class="badge score-badge">\${msg.score}</span>\`;
                    } else {
                        if (tbody.rows.length === 1 && tbody.rows[0].cells[0].textContent.includes('\u5C1A\u7121\u6578\u64DA')) {
                            tbody.innerHTML = '';
                        }
                        const newRow = tbody.insertRow();
                        const cellFile = newRow.insertCell(0);
                        const cellScore = newRow.insertCell(1);
                        cellFile.textContent = msg.fileName;
                        cellScore.innerHTML = \`<span class="badge score-badge">\${msg.score}</span>\`;
                    }
                    break;
            }
        });

        document.getElementById('env-type').onchange = (e) => {
            const isLocal = e.target.value === 'local';
            document.getElementById('local-ui').style.display = isLocal ? 'block' : 'none';
            document.getElementById('cloud-ui').style.display = isLocal ? 'none' : 'block';
        };

        document.getElementById('btn-browse-proj').onclick = () => vscode.postMessage({ command: 'browseProjectFolder' });
        document.getElementById('btn-browse-out').onclick = () => vscode.postMessage({ command: 'browseFolder' });
        
        document.getElementById('file-select').onchange = (e) => { 
            if(e.target.value) {
                vscode.postMessage({ command: 'getFunctions', filePath: e.target.value }); 
            } else {
                document.getElementById('func-select').innerHTML = '<option value="">-- \u4E00\u9375\u6E2C\u8A66\u5168\u90E8 (\u6B64\u6A94\u6848) --</option>';
            }
        };

        // --- \u5BC6\u9470\u7BA1\u7406\u6309\u9215\u8207 Modal \u908F\u8F2F ---
        const modal = document.getElementById('key-modal');
        const modalModel = document.getElementById('modal-model-name');
        const modalKey = document.getElementById('modal-api-key');
        let editingOldName = null;

        document.getElementById('btn-edit-key').onclick = () => {
            const select = document.getElementById('api-key-select');
            const selectedVal = select.value;
            if (selectedVal) {
                editingOldName = selectedVal;
                modalModel.value = selectedVal;
                modalKey.value = currentKeys[selectedVal] || '';
            } else {
                editingOldName = null;
                modalModel.value = '';
                modalKey.value = '';
            }
            modal.style.display = 'flex';
        };

        document.getElementById('btn-del-key').onclick = () => {
            const select = document.getElementById('api-key-select');
            const selectedVal = select.value;
            if (selectedVal) {
                if (confirm(\`\u78BA\u5B9A\u8981\u522A\u9664 \${selectedVal} \u7684\u5BC6\u9470\u55CE\uFF1F\`)) {
                    vscode.postMessage({ command: 'deleteApiKey', name: selectedVal });
                }
            } else {
                alert('\u8ACB\u5148\u9078\u64C7\u8981\u522A\u9664\u7684\u5BC6\u9470\uFF01');
            }
        };

        document.getElementById('modal-cancel').onclick = () => {
            modal.style.display = 'none';
        };

        document.getElementById('modal-save').onclick = () => {
            const modelName = modalModel.value.trim();
            const apiKey = modalKey.value.trim();
            if (!modelName || !apiKey) {
                alert('\u8ACB\u586B\u5BEB\u6A21\u578B\u540D\u7A31\u8207\u5BC6\u9470\u5167\u5BB9\uFF01');
                return;
            }
            vscode.postMessage({
                command: 'updateApiKey',
                oldName: editingOldName,
                newName: modelName,
                key: apiKey
            });
            modal.style.display = 'none';
        };

        // \u9EDE\u64CA Modal \u5916\u90E8\u4EA6\u53EF\u53D6\u6D88
        window.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        };

        document.getElementById('start-test').onclick = () => {
            const fileSelect = document.getElementById('file-select');
            if (!fileSelect.value) {
                alert('\u8ACB\u5148\u9078\u64C7\u76EE\u6A19 Python \u6A94\u6848\uFF01');
                return;
            }
            vscode.postMessage({
                command: 'startAnalysis',
                envType: document.getElementById('env-type').value,
                modelName: document.getElementById('env-type').value === 'local' ? document.getElementById('model-select').value : document.getElementById('api-key-select').value,
                filePath: fileSelect.value,
                funcName: document.getElementById('func-select').value,
                maxLoops: parseInt(document.getElementById('max-loop').value),
                timeoutSeconds: parseInt(document.getElementById('timeout-sec').value),
                outputPath: document.getElementById('output-path').value
            });
        };
    