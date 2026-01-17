/**
 * 批量验证服务前端 - 主逻辑
 * 域名: 1keyid.1yo.cc
 */

// 配置
const CONFIG = {
    API_BASE: '', // 同域名下无需配置
    STORAGE_KEY: 'batch_verify_api_key'
};

// 状态
const state = {
    apiKey: localStorage.getItem(CONFIG.STORAGE_KEY) || '',
    isProcessing: false,
    results: [],
    abortController: null
};

// DOM 元素
const DOM = {
    // 输入面板
    inputArea: document.getElementById('inputArea'),
    idCount: document.getElementById('idCount'),
    startBtn: document.getElementById('startBtn'),
    clearBtn: document.getElementById('clearBtn'),
    statusBadge: document.getElementById('statusBadge'),
    statusText: document.getElementById('statusText'),

    // API Key
    setApiKeyBtn: document.getElementById('setApiKeyBtn'),
    apiKeyStatus: document.getElementById('apiKeyStatus'),
    apiKeyModal: document.getElementById('apiKeyModal'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    saveApiKeyBtn: document.getElementById('saveApiKeyBtn'),
    cancelModalBtn: document.getElementById('cancelModalBtn'),
    closeModalBtn: document.getElementById('closeModalBtn'),
    quotaInfo: document.getElementById('quotaInfo'),

    // 结果面板
    resultsContainer: document.getElementById('resultsContainer'),
    resultsList: document.getElementById('resultsList'),
    emptyState: document.getElementById('emptyState'),
    clearResultsBtn: document.getElementById('clearResultsBtn'),
    exportBtn: document.getElementById('exportBtn')
};

// ============ 工具函数 ============

/**
 * 从输入中提取验证 ID
 * 支持直接 ID 或从 URL 中提取
 */
function extractVerificationIds(input) {
    const lines = input.split('\n').filter(line => line.trim());
    const ids = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 尝试从 URL 提取
        const urlPatterns = [
            /verificationId=([a-zA-Z0-9_-]+)/i,
            /verification_id=([a-zA-Z0-9_-]+)/i,
            /vid=([a-zA-Z0-9_-]+)/i,
            /\/verify\/([a-zA-Z0-9_-]+)/i
        ];

        let extracted = null;
        for (const pattern of urlPatterns) {
            const match = trimmed.match(pattern);
            if (match) {
                extracted = match[1];
                break;
            }
        }

        ids.push(extracted || trimmed);
    }

    return [...new Set(ids)]; // 去重
}

/**
 * 更新状态显示
 */
function updateStatus(status, text) {
    DOM.statusBadge.className = 'status-badge ' + status;
    DOM.statusText.textContent = text;
}

/**
 * 更新 API Key 显示
 */
function updateApiKeyDisplay() {
    if (state.apiKey) {
        // 显示部分 key
        const masked = state.apiKey.substring(0, 8) + '...' + state.apiKey.slice(-4);
        DOM.apiKeyStatus.textContent = '✓ ' + masked;
        DOM.apiKeyStatus.classList.add('active');
    } else {
        DOM.apiKeyStatus.textContent = '未设置';
        DOM.apiKeyStatus.classList.remove('active');
    }
}

/**
 * 添加结果项
 */
function addResult(id, status, message) {
    // 检查是否已存在，如果存在则更新
    const existingIndex = state.results.findIndex(r => r.id === id);
    if (existingIndex >= 0) {
        state.results[existingIndex] = { id, status, message };
    } else {
        state.results.push({ id, status, message });
    }

    renderResults();
}

/**
 * 渲染结果列表
 */
function renderResults() {
    if (state.results.length === 0) {
        DOM.emptyState.classList.remove('hidden');
        DOM.resultsList.innerHTML = '';
        return;
    }

    DOM.emptyState.classList.add('hidden');
    DOM.resultsList.innerHTML = state.results.map(r => `
        <div class="result-item ${r.status}">
            <span class="result-id">${escapeHtml(r.id)}</span>
            <span class="result-status">${escapeHtml(r.message)}</span>
        </div>
    `).join('');
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============ API 调用 ============

/**
 * 获取 CSRF Token
 * 从上游服务首页动态获取
 */
async function getCsrfToken() {
    // 优先使用缓存的 Token（5分钟内有效）
    if (window._csrfToken && window._csrfTokenTime && (Date.now() - window._csrfTokenTime < 300000)) {
        return window._csrfToken;
    }

    try {
        // 请求上游首页（通过 Nginx 代理）
        const response = await fetch('/upstream/');
        if (response.ok) {
            const html = await response.text();
            // 从 HTML 中提取 CSRF_TOKEN
            const match = html.match(/CSRF_TOKEN\s*=\s*["']([^"']+)["']/);
            if (match && match[1]) {
                window._csrfToken = match[1];
                window._csrfTokenTime = Date.now();
                console.log('✅ CSRF Token 获取成功');
                return match[1];
            }
        }
    } catch (e) {
        console.warn('获取 CSRF Token 失败:', e);
    }

    return '';
}

/**
 * 开始批量验证
 */
async function startVerification(ids) {
    if (!state.apiKey) {
        alert('请先设置 API Key');
        return;
    }

    if (ids.length === 0) {
        alert('请输入验证 ID');
        return;
    }

    state.isProcessing = true;
    updateStatus('processing', '验证中...');
    DOM.startBtn.disabled = true;
    DOM.startBtn.textContent = '⏳ 处理中...';

    // 为每个 ID 添加处理中状态
    ids.forEach(id => addResult(id, 'processing', '处理中...'));

    try {
        const csrfToken = await getCsrfToken();
        state.abortController = new AbortController();

        const response = await fetch('/api/batch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                hCaptchaToken: state.apiKey,
                verificationIds: ids
            }),
            signal: state.abortController.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // 处理 SSE 事件流
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        handleSSEData(data);
                    } catch (e) {
                        console.log('SSE 数据解析跳过:', line);
                    }
                } else if (line.startsWith('event: ')) {
                    const eventType = line.substring(7).trim();
                    handleSSEEvent(eventType);
                }
            }
        }

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('验证已取消');
        } else {
            console.error('验证失败:', error);
            alert('验证请求失败: ' + error.message);
        }
    } finally {
        state.isProcessing = false;
        state.abortController = null;
        updateStatus('', '就绪');
        DOM.startBtn.disabled = false;
        DOM.startBtn.textContent = '▶ 开始验证';
    }
}

/**
 * 处理 SSE 数据
 */
function handleSSEData(data) {
    console.log('SSE 数据:', data);

    // 处理验证结果
    if (data.verificationId) {
        const status = data.currentStep === 'success' ? 'success' :
            data.currentStep === 'error' ? 'error' : 'processing';
        const message = data.message || data.currentStep || '未知';
        addResult(data.verificationId, status, message);
    }

    // 处理配额信息
    if (data.current_quota !== undefined) {
        DOM.quotaInfo.textContent = `配额: ${data.current_quota}`;
    }

    // 处理开始事件数据
    if (data.total !== undefined && data.cost !== undefined) {
        console.log(`开始处理 ${data.total} 个验证，消耗 ${data.cost}`);
    }

    // 处理结束事件数据
    if (data.completed !== undefined) {
        console.log(`完成 ${data.completed}/${data.total}`);
    }
}

/**
 * 处理 SSE 事件类型
 */
function handleSSEEvent(eventType) {
    console.log('SSE 事件:', eventType);

    if (eventType === 'start') {
        updateStatus('processing', '验证中...');
    } else if (eventType === 'end') {
        updateStatus('', '完成');
    }
}

/**
 * 导出结果
 */
function exportResults() {
    if (state.results.length === 0) {
        alert('暂无结果可导出');
        return;
    }

    // 分类导出
    const success = state.results.filter(r => r.status === 'success');
    const failed = state.results.filter(r => r.status === 'error');

    let content = '=== 批量验证结果 ===\n';
    content += `时间: ${new Date().toLocaleString()}\n`;
    content += `总计: ${state.results.length} | 成功: ${success.length} | 失败: ${failed.length}\n\n`;

    if (success.length > 0) {
        content += '--- 成功 ---\n';
        success.forEach(r => {
            content += `${r.id}\t${r.message}\n`;
        });
        content += '\n';
    }

    if (failed.length > 0) {
        content += '--- 失败 ---\n';
        failed.forEach(r => {
            content += `${r.id}\t${r.message}\n`;
        });
    }

    // 下载文件
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `验证结果_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============ 事件绑定 ============

// 输入区域 - 实时统计
DOM.inputArea.addEventListener('input', () => {
    const ids = extractVerificationIds(DOM.inputArea.value);
    DOM.idCount.textContent = ids.length;
});

// 清空输入
DOM.clearBtn.addEventListener('click', () => {
    DOM.inputArea.value = '';
    DOM.idCount.textContent = '0';
});

// 开始验证
DOM.startBtn.addEventListener('click', () => {
    if (state.isProcessing) {
        // 取消验证
        if (state.abortController) {
            state.abortController.abort();
        }
        return;
    }

    const ids = extractVerificationIds(DOM.inputArea.value);
    startVerification(ids);
});

// 清空结果
DOM.clearResultsBtn.addEventListener('click', () => {
    state.results = [];
    renderResults();
});

// 导出结果
DOM.exportBtn.addEventListener('click', exportResults);

// API Key 弹窗
DOM.setApiKeyBtn.addEventListener('click', () => {
    DOM.apiKeyInput.value = state.apiKey;
    DOM.apiKeyModal.classList.add('active');
});

DOM.closeModalBtn.addEventListener('click', () => {
    DOM.apiKeyModal.classList.remove('active');
});

DOM.cancelModalBtn.addEventListener('click', () => {
    DOM.apiKeyModal.classList.remove('active');
});

DOM.saveApiKeyBtn.addEventListener('click', () => {
    const key = DOM.apiKeyInput.value.trim();
    if (key) {
        state.apiKey = key;
        localStorage.setItem(CONFIG.STORAGE_KEY, key);
        updateApiKeyDisplay();
    }
    DOM.apiKeyModal.classList.remove('active');
});

// 点击背景关闭弹窗
DOM.apiKeyModal.querySelector('.modal-backdrop').addEventListener('click', () => {
    DOM.apiKeyModal.classList.remove('active');
});

// ============ 初始化 ============

function init() {
    updateApiKeyDisplay();
    renderResults();
    console.log('批量验证服务前端已初始化');
}

init();
