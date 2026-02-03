const { ipcRenderer } = require('electron');

let isConnected = false;
let currentTimezoneOffset = 8;
let satelliteData = [];
let rawDataBuffer = '';
let modbusRunning = false;
let ntpRunning = false;
const MAX_RAW_DATA_LINES = 50;

// DOM元素
const portSelect = document.getElementById('portSelect');
const baudRateSelect = document.getElementById('baudRate');
const gnssSelect = document.getElementById('gnssSelect');
const timezoneSelect = document.getElementById('timezoneSelect');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const refreshBtn = document.getElementById('refreshBtn');
const connectionStatus = document.getElementById('connectionStatus');
const rawDataDiv = document.getElementById('rawData');

// Modbus服务元素
const modbusIPSelect = document.getElementById('modbusIP');
const modbusPortInput = document.getElementById('modbusPort');
const startModbusBtn = document.getElementById('startModbusBtn');
const stopModbusBtn = document.getElementById('stopModbusBtn');
const modbusStatus = document.getElementById('modbusStatus');
const showModbusDataBtn = document.getElementById('showModbusDataBtn');

// NTP服务元素
const ntpIPSelect = document.getElementById('ntpIP');
const ntpPortInput = document.getElementById('ntpPort');
const ntpTimezoneSelect = document.getElementById('ntpTimezone');
const startNtpBtn = document.getElementById('startNtpBtn');
const stopNtpBtn = document.getElementById('stopNtpBtn');
const ntpStatus = document.getElementById('ntpStatus');

// 显示元素
const gnssDisplay = document.getElementById('gnssDisplay');
const dateDisplay = document.getElementById('dateDisplay');
const timeDisplay = document.getElementById('timeDisplay');
const altitudeDisplay = document.getElementById('altitudeDisplay');
const statusDisplay = document.getElementById('statusDisplay');
const satellitesDisplay = document.getElementById('satellitesDisplay');
const longitudeDisplay = document.getElementById('longitudeDisplay');
const latitudeDisplay = document.getElementById('latitudeDisplay');
const qualityDisplay = document.getElementById('qualityDisplay');
const pdopValue = document.getElementById('pdopValue');
const hdopValue = document.getElementById('hdopValue');
const vdopValue = document.getElementById('vdopValue');
const skyViewCanvas = document.getElementById('skyView');
const signalBars = document.getElementById('signalBars');

// 初始化
async function init() {
  await refreshPorts();
  await loadLocalIPs();
  setupEventListeners();
  initSkyView();
  showModbusDataBtn.disabled = true; // 初始禁用查看按钮
}

// 获取本地IP列表
async function loadLocalIPs() {
  try {
    const result = await ipcRenderer.invoke('get-local-ips');
    if (result.success) {
      const ips = result.ips;

      // 填充Modbus IP选择框
      modbusIPSelect.innerHTML = '<option value="">-- 选择IP地址 --</option>';
      ips.forEach(ip => {
        const option = document.createElement('option');
        option.value = ip;
        option.textContent = ip;
        modbusIPSelect.appendChild(option);
      });

      // 填充NTP IP选择框
      ntpIPSelect.innerHTML = '<option value="">-- 选择IP地址 --</option>';
      ips.forEach(ip => {
        const option = document.createElement('option');
        option.value = ip;
        option.textContent = ip;
        ntpIPSelect.appendChild(option);
      });

      // 默认选择第一个外部IP
      if (ips.length > 0) {
        modbusIPSelect.value = ips[0];
        ntpIPSelect.value = ips[0];
      }
    }
  } catch (error) {
    console.error('获取本地IP失败:', error);
  }
}

// 设置事件监听
function setupEventListeners() {
  connectBtn.addEventListener('click', connectSerial);
  disconnectBtn.addEventListener('click', disconnectSerial);
  refreshBtn.addEventListener('click', refreshPorts);
  gnssSelect.addEventListener('change', async (e) => {
    const system = e.target.value;
    // 同步GNSS系统选择到主进程
    await ipcRenderer.invoke('update-gnss-system', system);
    addRawData(`定位系统切换为: ${system === 'auto' ? '自动' : system === 'beidou' ? '北斗' : 'GPS'}`);
  });
  timezoneSelect.addEventListener('change', async (e) => {
    const option = e.target.selectedOptions[0];
    currentTimezoneOffset = parseInt(option.dataset.offset);
    // 同步时区到主进程
    await ipcRenderer.invoke('update-timezone', currentTimezoneOffset);
  });

  // Modbus服务按钮
  startModbusBtn.addEventListener('click', startModbusServer);
  stopModbusBtn.addEventListener('click', stopModbusServer);

  // NTP服务按钮
  startNtpBtn.addEventListener('click', startNtpServer);
  stopNtpBtn.addEventListener('click', stopNtpServer);

  // 监听串口数据
  ipcRenderer.on('serial-data', (event, data) => {
    handleSerialData(data);
  });

  // 监听串口错误
  ipcRenderer.on('serial-error', (event, error) => {
    addRawData(`错误: ${error}`, true);
    updateConnectionStatus(false);
  });
}

// ========== Modbus Server相关 ==========

async function startModbusServer() {
  const port = parseInt(modbusPortInput.value);
  const host = modbusIPSelect.value;

  if (!port || port < 1 || port > 65535) {
    alert('请输入有效的端口号 (1-65535)');
    return;
  }

  if (!host) {
    alert('请选择要绑定的IP地址');
    return;
  }

  try {
    const result = await ipcRenderer.invoke('start-modbus-server', port, host);
    if (result.success) {
      modbusRunning = true;
      updateModbusStatus(true, host);
      addRawData(result.message);
    } else {
      alert(result.message);
      addRawData(result.message, true);
    }
  } catch (error) {
    console.error('启动Modbus服务器失败:', error);
    alert(error.message);
  }
}

async function stopModbusServer() {
  try {
    const result = await ipcRenderer.invoke('stop-modbus-server');
    if (result.success) {
      modbusRunning = false;
      updateModbusStatus(false);
      addRawData(result.message);
    }
  } catch (error) {
    console.error('停止Modbus服务器失败:', error);
  }
}

function updateModbusStatus(running, address = '0.0.0.0') {
  if (running) {
    modbusStatus.textContent = `● 运行中 (地址: ${address}, 端口: ${modbusPortInput.value})`;
    modbusStatus.classList.remove('offline');
    modbusStatus.classList.add('online');
    startModbusBtn.disabled = true;
    stopModbusBtn.disabled = false;
    showModbusDataBtn.disabled = false;
  } else {
    modbusStatus.textContent = '● 未启动';
    modbusStatus.classList.remove('online');
    modbusStatus.classList.add('offline');
    startModbusBtn.disabled = false;
    stopModbusBtn.disabled = true;
    showModbusDataBtn.disabled = true;
  }
}

// ========== NTP Server相关 ==========

async function startNtpServer() {
  const port = parseInt(ntpPortInput.value);
  const timezone = parseInt(ntpTimezoneSelect.value);
  const host = ntpIPSelect.value;

  if (!port || port < 1 || port > 65535) {
    alert('请输入有效的端口号 (1-65535)');
    return;
  }

  if (!host) {
    alert('请选择要绑定的IP地址');
    return;
  }

  try {
    const result = await ipcRenderer.invoke('start-ntp-server', port, timezone, host);
    if (result.success) {
      ntpRunning = true;
      updateNtpStatus(true, host);
      addRawData(result.message);
    } else {
      alert(result.message);
      addRawData(result.message, true);
    }
  } catch (error) {
    console.error('启动NTP服务器失败:', error);
    alert(error.message);
  }
}

async function stopNtpServer() {
  try {
    const result = await ipcRenderer.invoke('stop-ntp-server');
    if (result.success) {
      ntpRunning = false;
      updateNtpStatus(false);
      addRawData(result.message);
    }
  } catch (error) {
    console.error('停止NTP服务器失败:', error);
  }
}

function updateNtpStatus(running, address = '0.0.0.0') {
  if (running) {
    const timezone = ntpTimezoneSelect.value >= 0 ? `+${ntpTimezoneSelect.value}` : ntpTimezoneSelect.value;
    ntpStatus.textContent = `● 运行中 (地址: ${address}, 端口: ${ntpPortInput.value}, 时区: UTC${timezone})`;
    ntpStatus.classList.remove('offline');
    ntpStatus.classList.add('online');
    startNtpBtn.disabled = true;
    stopNtpBtn.disabled = false;
  } else {
    ntpStatus.textContent = '● 未启动';
    ntpStatus.classList.remove('online');
    ntpStatus.classList.add('offline');
    startNtpBtn.disabled = false;
    stopNtpBtn.disabled = true;
  }
}

// 刷新串口列表
async function refreshPorts() {
  try {
    const ports = await ipcRenderer.invoke('get-serial-ports');
    portSelect.innerHTML = '<option value="">-- 请选择串口 --</option>';

    ports.forEach(port => {
      const option = document.createElement('option');
      option.value = port.path;
      option.textContent = `${port.path} (${port.manufacturer || '未知设备'})`;
      portSelect.appendChild(option);
    });
  } catch (error) {
    console.error('获取串口列表失败:', error);
    addRawData(`获取串口列表失败: ${error.message}`, true);
  }
}

// 连接串口
async function connectSerial() {
  const portPath = portSelect.value;
  if (!portPath) {
    alert('请先选择串口！');
    return;
  }

  const baudRate = parseInt(baudRateSelect.value);

  try {
    const result = await ipcRenderer.invoke('connect-serial', portPath, baudRate);
    if (result.success) {
      isConnected = true;
      updateConnectionStatus(true);
      addRawData(`串口 ${portPath} 连接成功 (波特率: ${baudRate})`);
    } else {
      alert(result.message);
      addRawData(result.message, true);
    }
  } catch (error) {
    console.error('连接串口失败:', error);
    alert(error.message);
  }
}

// 断开串口
async function disconnectSerial() {
  try {
    const result = await ipcRenderer.invoke('disconnect-serial');
    if (result.success) {
      isConnected = false;
      updateConnectionStatus(false);
      addRawData('串口已断开');
    }
  } catch (error) {
    console.error('断开串口失败:', error);
  }
}

// 更新连接状态
function updateConnectionStatus(connected) {
  isConnected = connected;
  if (connected) {
    connectionStatus.textContent = '● 已连接';
    connectionStatus.classList.remove('offline');
    connectionStatus.classList.add('online');
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  } else {
    connectionStatus.textContent = '● 未连接';
    connectionStatus.classList.remove('online');
    connectionStatus.classList.add('offline');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }
}

// 处理串口数据
function handleSerialData(data) {
  addRawData(data.raw);

  // 更新GNSS系统显示
  if (data.gnssSystem) {
    const systemText = {
      'auto': '自动',
      'beidou': '北斗',
      'gps': 'GPS'
    };
    gnssDisplay.textContent = systemText[data.gnssSystem] || '自动';
  }

  switch (data.type) {
    case '$GPRMC':
    case '$GNRMC':
      updateDateTime(data);
      if (data.status === '有效') {
        statusDisplay.textContent = '定位有效';
        statusDisplay.style.color = '#51cf66';
        if (data.position) {
          longitudeDisplay.textContent = data.position.longitude.toFixed(6);
          latitudeDisplay.textContent = data.position.latitude.toFixed(6);
        }
      } else {
        statusDisplay.textContent = '定位无效';
        statusDisplay.style.color = '#ff6b6b';
      }
      break;

    case '$GPGGA':
    case '$GNGGA':
      if (data.position) {
        longitudeDisplay.textContent = data.position.longitude.toFixed(6);
        latitudeDisplay.textContent = data.position.latitude.toFixed(6);
      }
      altitudeDisplay.textContent = `${data.altitude.toFixed(1)} m`;
      satellitesDisplay.textContent = data.satellites;
      qualityDisplay.textContent = data.qualityDesc;
      hdopValue.textContent = data.hdop.toFixed(1);
      break;

    case '$GPGSV':
    case '$BDGSV':
      if (data.gsv && data.gsv.satellitesInView) {
        data.gsv.satellitesInView.forEach(sat => {
          const existingIndex = satelliteData.findIndex(s => s.id === sat.id);
          if (existingIndex >= 0) {
            satelliteData[existingIndex] = sat;
          } else {
            satelliteData.push(sat);
          }
        });
        updateSatelliteView();
      }
      break;

    case '$GPGSA':
    case '$BDGSA':
      if (data.gsa) {
        pdopValue.textContent = data.gsa.pdop.toFixed(1);
        hdopValue.textContent = data.gsa.hdop.toFixed(1);
        vdopValue.textContent = data.gsa.vdop.toFixed(1);
      }
      break;
  }
}

// 更新日期时间
function updateDateTime(data) {
  if (data.date && data.time) {
    const { year, month, day } = data.date;
    const { hours, minutes, seconds } = data.time;

    // 应用时区偏移
    let adjustedHours = hours + currentTimezoneOffset;
    if (adjustedHours >= 24) {
      adjustedHours -= 24;
    } else if (adjustedHours < 0) {
      adjustedHours += 24;
    }

    dateDisplay.textContent = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    timeDisplay.textContent = `${String(adjustedHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
}

// 更新卫星视图
function updateSatelliteView() {
  // 排序卫星数据
  satelliteData.sort((a, b) => a.id - b.id);

  // 更新天空视图
  drawSkyView();

  // 更新信号强度条
  updateSignalBars();
}

// 初始化天空视图
function initSkyView() {
  drawSkyView();
}

// 绘制天空视图
function drawSkyView() {
  const ctx = skyViewCanvas.getContext('2d');
  const centerX = skyViewCanvas.width / 2;
  const centerY = skyViewCanvas.height / 2;
  const maxRadius = Math.min(centerX, centerY) - 20;

  // 清空画布
  ctx.clearRect(0, 0, skyViewCanvas.width, skyViewCanvas.height);

  // 绘制渐变背景
  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(1, '#0f3460');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, skyViewCanvas.width, skyViewCanvas.height);

  // 绘制同心圆（仰角圈）
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1;
  [0.2, 0.5, 0.8, 1].forEach(ratio => {
    ctx.beginPath();
    ctx.arc(centerX, centerY, maxRadius * ratio, 0, Math.PI * 2);
    ctx.stroke();
  });

  // 绘制方位角线
  [0, 45, 90, 135, 180, 225, 270, 315].forEach(angle => {
    const radian = (angle - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(
      centerX + maxRadius * Math.cos(radian),
      centerY + maxRadius * Math.sin(radian)
    );
    ctx.stroke();

    // 绘制方位角标签
    const labelRadius = maxRadius * 1.1;
    ctx.font = '14px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${angle}°`,
      centerX + labelRadius * Math.cos(radian),
      centerY + labelRadius * Math.sin(radian)
    );
  });

  // 绘制仰角标签
  ctx.font = '12px Arial';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.fillText('90°', centerX, centerY - 15);
  ctx.fillText('60°', centerX, centerY - maxRadius * 0.2 - 5);
  ctx.fillText('30°', centerX, centerY - maxRadius * 0.5 - 5);
  ctx.fillText('0°', centerX, centerY - maxRadius - 5);

  // 绘制中心点（观察者位置）
  ctx.beginPath();
  ctx.arc(centerX, centerY, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  // 绘制卫星
  satelliteData.forEach(satellite => {
    if (satellite.elevation !== undefined && satellite.azimuth !== undefined) {
      // 计算卫星位置
      const elevationRadius = (1 - satellite.elevation / 90) * maxRadius;
      const azimuthRadian = (satellite.azimuth - 90) * Math.PI / 180;

      const satX = centerX + elevationRadius * Math.cos(azimuthRadian);
      const satY = centerY + elevationRadius * Math.sin(azimuthRadian);

      // 根据信噪比确定卫星颜色和大小
      let satColor, satSize;
      if (satellite.snr === 0 || !satellite.snr) {
        satColor = 'rgba(255, 107, 107, 0.8)';
        satSize = 6;
      } else if (satellite.snr < 30) {
        satColor = 'rgba(255, 193, 7, 0.9)';
        satSize = 8;
      } else {
        satColor = 'rgba(81, 207, 102, 1)';
        satSize = 10;
      }

      // 绘制卫星光晕
      const glowGradient = ctx.createRadialGradient(satX, satY, 0, satX, satY, satSize * 2);
      glowGradient.addColorStop(0, satColor);
      glowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.beginPath();
      ctx.arc(satX, satY, satSize * 2, 0, Math.PI * 2);
      ctx.fillStyle = glowGradient;
      ctx.fill();

      // 绘制卫星点
      ctx.beginPath();
      ctx.arc(satX, satY, satSize, 0, Math.PI * 2);
      ctx.fillStyle = satColor;
      ctx.fill();

      // 绘制卫星ID
      ctx.font = 'bold 11px Arial';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(
        satellite.id,
        satX,
        satY - satSize - 5
      );
    }
  });
}

// 更新信号强度条
function updateSignalBars() {
  signalBars.innerHTML = '';

  satelliteData.forEach(satellite => {
    const signalItem = document.createElement('div');
    signalItem.className = 'signal-item';

    let signalClass = 'weak';
    if (satellite.snr >= 30) {
      signalClass = 'strong';
    } else if (satellite.snr >= 20) {
      signalClass = 'moderate';
    }

    const signalValue = satellite.snr > 0 ? satellite.snr : 0;

    signalItem.innerHTML = `
      <div class="signal-id">PRN-${satellite.id}</div>
      <div class="signal-bar-container">
        <div class="signal-bar ${signalClass}" style="width: ${signalValue * 3}%">
          <span style="position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 10px; font-weight: bold; color: #333;">
            ${satellite.elevation}°/${satellite.azimuth}°
          </span>
        </div>
      </div>
      <div class="signal-value">${signalValue} dB</div>
    `;

    signalBars.appendChild(signalItem);
  });
}

// 添加原始数据
function addRawData(text, isError = false) {
  const timestamp = new Date().toLocaleTimeString('zh-CN');
  const line = document.createElement('div');
  line.textContent = `[${timestamp}] ${text}`;
  if (isError) {
    line.style.color = '#dc3545';
    line.style.fontWeight = 'bold';
  }
  rawDataDiv.appendChild(line);

  // 限制行数
  while (rawDataDiv.children.length > MAX_RAW_DATA_LINES) {
    rawDataDiv.removeChild(rawDataDiv.firstChild);
  }

  // 滚动到底部
  rawDataDiv.scrollTop = rawDataDiv.scrollHeight;
}

// 启动应用
init();

// 初始化拖拽和图例功能
initDragAndDrop();
initSkyViewLegend();
addLayoutControls();

// 暴露重置布局函数到全局作用域，供HTML调用
globalThis.resetLayout = resetLayout;

// ========== 拖拽布局功能 ==========
let draggedElement = null;
let draggedContainer = null;
let placeholder = null;

// 初始化拖拽功能
function initDragAndDrop() {
  const containers = document.querySelectorAll('.sortable-container');
  
  containers.forEach(container => {
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);
    container.addEventListener('dragenter', handleDragEnter);
    container.addEventListener('dragleave', handleDragLeave);
  });
  
  // 为所有可拖拽元素添加事件监听
  document.addEventListener('dragstart', handleDragStart);
  document.addEventListener('dragend', handleDragEnd);
  
  // 添加拖拽手柄
  addDragHandles();
  
  // 加载保存的布局
  loadLayout();
}

// 添加拖拽手柄到面板和卡片
function addDragHandles() {
  const panels = document.querySelectorAll('.panel.sortable-item');
  const cards = document.querySelectorAll('.card.sortable-item');
  
  [...panels, ...cards].forEach(item => {
    if (!item.querySelector('.drag-handle')) {
      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.innerHTML = '⋮⋮';
      handle.title = '拖拽重新布局';
      item.style.position = 'relative';
      item.appendChild(handle);
    }
  });
}

function handleDragStart(e) {
  // 允许直接拖拽面板/卡片的任何位置，或者拖拽手柄
  const sortableItem = e.target.closest('.sortable-item');
  if (!sortableItem) return;
  
  draggedElement = sortableItem;
  draggedContainer = draggedElement.parentElement;
  draggedElement.classList.add('dragging');
  
  // 创建占位符
  placeholder = document.createElement('div');
  placeholder.className = 'sortable-placeholder';
  
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', draggedElement.outerHTML);
}

function handleDragOver(e) {
  if (!draggedElement) return;
  
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  
  const container = e.currentTarget;
  const afterElement = getDragAfterElement(container, e.clientY);
  
  if (afterElement == null) {
    container.appendChild(placeholder);
  } else {
    container.insertBefore(placeholder, afterElement);
  }
}

function handleDragEnter(e) {
  if (!draggedElement) return;
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
  // 检查是否真的离开了容器
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drag-over');
  }
}

function handleDrop(e) {
  if (!draggedElement) return;
  
  e.preventDefault();
  
  if (placeholder && placeholder.parentNode) {
    placeholder.parentNode.insertBefore(draggedElement, placeholder);
    placeholder.remove();
  }
  
  // 清理样式
  document.querySelectorAll('.drag-over').forEach(el => {
    el.classList.remove('drag-over');
  });
  
  // 保存布局
  saveLayout();
}

function handleDragEnd(e) {
  if (!draggedElement) return;
  
  draggedElement.classList.remove('dragging');
  
  // 清理所有拖拽相关样式
  document.querySelectorAll('.drag-over').forEach(el => {
    el.classList.remove('drag-over');
  });
  
  if (placeholder) {
    placeholder.remove();
  }
  
  draggedElement = null;
  draggedContainer = null;
  placeholder = null;
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.sortable-item:not(.dragging)')];
  
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// 保存布局到localStorage
function saveLayout() {
  const layout = {};
  
  // 保存侧边栏面板顺序
  const sidebarPanels = [...document.querySelectorAll('#sidebarContainer .sortable-item')];
  layout.sidebar = sidebarPanels.map(panel => panel.dataset.panel);
  
  // 保存仪表盘卡片顺序
  const cardContainers = ['#cardsContainer', '#cardsContainer2', '#cardsContainer3'];
  layout.cards = {};
  cardContainers.forEach(containerId => {
    const container = document.querySelector(containerId);
    if (container) {
      const cards = [...container.querySelectorAll('.sortable-item')];
      layout.cards[containerId] = cards.map(card => card.dataset.card);
    }
  });
  
  // 保存信息面板顺序（卫星可视化和信号强度）
  const infoPanels = [...document.querySelectorAll('.info-panels-row .sortable-item')];
  layout.infoPanels = infoPanels.map(panel => panel.dataset.panel);
  
  localStorage.setItem('beidou-layout', JSON.stringify(layout));
}

// 从localStorage加载布局
function loadLayout() {
  try {
    const saved = localStorage.getItem('beidou-layout');
    if (!saved) return;
    
    const layout = JSON.parse(saved);
    
    // 恢复侧边栏面板顺序
    if (layout.sidebar && Array.isArray(layout.sidebar)) {
      const sidebar = document.getElementById('sidebarContainer');
      layout.sidebar.forEach(panelType => {
        const panel = sidebar.querySelector(`[data-panel="${panelType}"]`);
        if (panel) {
          sidebar.appendChild(panel);
        }
      });
    }
    
    // 恢复卡片顺序
    if (layout.cards) {
      Object.entries(layout.cards).forEach(([containerId, cardTypes]) => {
        // 映射旧的容器ID到新的ID
        let selector = containerId;
        if (containerId === '#cardsContainer') selector = '#cardsContainer';
        if (containerId === '#cardsContainer2') selector = '#cardsContainer2';
        if (containerId === '#cardsContainer3') selector = '#cardsContainer3';
        
        const container = document.querySelector(selector);
        if (container && Array.isArray(cardTypes)) {
          cardTypes.forEach(cardType => {
            const card = container.querySelector(`[data-card="${cardType}"]`);
            if (card) {
              container.appendChild(card);
            }
          });
        }
      });
    }
    
    // 恢复信息面板顺序（卫星可视化和信号强度）
    if (layout.infoPanels && Array.isArray(layout.infoPanels)) {
      const dashboard = document.querySelector('.info-panels-row');
      if (dashboard) {
        layout.infoPanels.forEach(panelType => {
          const panel = dashboard.querySelector(`[data-panel="${panelType}"]`);
          if (panel) {
            dashboard.appendChild(panel);
          }
        });
      }
    }
    
  } catch (error) {
    console.error('加载布局失败:', error);
  }
}

// 重置布局
function resetLayout() {
  if (confirm('确定要重置为默认布局吗？')) {
    localStorage.removeItem('beidou-layout');
    location.reload();
  }
}

// 添加布局控制按钮
function addLayoutControls() {
  const controlsDiv = document.createElement('div');
  controlsDiv.className = 'layout-controls';
  controlsDiv.innerHTML = `
    <button class="layout-reset-btn" onclick="resetLayout()">🔄 重置布局</button>
  `;
  document.body.appendChild(controlsDiv);
}

// ========== 卫星图例功能 ==========

// 初始化卫星图例
function initSkyViewLegend() {
  const legendToggle = document.getElementById('legendToggle');
  const legend = document.getElementById('skyviewLegend');
  
  if (legendToggle && legend) {
    legendToggle.addEventListener('click', () => {
      const isVisible = legend.style.display !== 'none';
      legend.style.display = isVisible ? 'none' : 'block';
      legendToggle.textContent = isVisible ? '📋 图例' : '❌ 关闭图例';
      
      // 保存图例状态
      localStorage.setItem('skyview-legend-visible', !isVisible);
    });
    
    // 恢复图例状态
    const legendVisible = localStorage.getItem('skyview-legend-visible');
    if (legendVisible === 'true') {
      legend.style.display = 'block';
      legendToggle.textContent = '❌ 关闭图例';
    }
  }
}

// ========== Modbus数据对话框相关 ==========

const modbusDataModal = document.getElementById('modbusDataModal');
const closeBtn = document.querySelector('.close-btn');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

// 显示Modbus数据对话框
showModbusDataBtn.addEventListener('click', async () => {
  if (!modbusRunning) {
    alert('请先启动Modbus服务器！');
    return;
  }

  modbusDataModal.style.display = 'block';
  await updateModbusDataDisplay();
});

// 关闭对话框
closeBtn.addEventListener('click', () => {
  modbusDataModal.style.display = 'none';
});

// 点击对话框外部关闭
window.addEventListener('click', (event) => {
  if (event.target === modbusDataModal) {
    modbusDataModal.style.display = 'none';
  }
});

// 标签切换
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    // 移除所有active类
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    // 添加active类到当前标签
    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(`${tabId}-tab`).classList.add('active');

    // 更新数据
    updateModbusDataDisplay();
  });
});

// 更新Modbus数据显示
async function updateModbusDataDisplay() {
  try {
    const result = await ipcRenderer.invoke('get-modbus-status');
    if (result.success && result.status.isRunning) {
      const { holdingRegisters, inputRegisters } = result.status;

      // 更新保持寄存器
      for (let i = 1; i <= 22; i++) {
        const regElement = document.getElementById(`reg-${i}`);
        if (regElement) {
          regElement.textContent = holdingRegisters[i - 1];
        }
      }

      // 更新输入寄存器
      for (let i = 1; i <= 4; i++) {
        const regElement = document.getElementById(`input-reg-${i}`);
        if (regElement) {
          regElement.textContent = inputRegisters[i - 1];
        }
      }
    }
  } catch (error) {
    console.error('更新Modbus数据失败:', error);
  }
}

// 每秒更新一次对话框数据
setInterval(() => {
  if (modbusDataModal.style.display === 'block') {
    updateModbusDataDisplay();
  }
}, 1000);

