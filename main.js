const { app, BrowserWindow, ipcMain } = require('electron');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const ModbusTCPServer = require('./modbus-server');
const NTPServer = require('./ntp-server');
const path = require('path');

let mainWindow;
let serialPort = null;
let parser = null;
let modbusServer = null;
let ntpServer = null;
let currentTimezoneOffset = 8; // 当前时区偏移（默认UTC+8）
let gnssSystem = 'auto'; // 定位系统选择（auto/beidou/gps）
let lastModbusUpdate = 0; // 上次更新Modbus寄存器的时间
const MODBUS_UPDATE_INTERVAL = 100; // Modbus寄存器更新最小间隔(ms)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 获取可用串口列表
ipcMain.handle('get-serial-ports', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer || '未知',
      serialNumber: port.serialNumber || '未知',
      vendorId: port.vendorId || '未知',
      productId: port.productId || '未知'
    }));
  } catch (error) {
    console.error('获取串口列表失败:', error);
    return [];
  }
});

// 获取本地IP列表
ipcMain.handle('get-local-ips', async () => {
  try {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const ips = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // 跳过内部IP和非IPv4地址
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }

    // 如果没有找到外部IP，添加回环地址
    if (ips.length === 0) {
      ips.push('127.0.0.1');
    }

    return { success: true, ips: ips };
  } catch (error) {
    console.error('获取本地IP失败:', error);
    return { success: false, ips: ['127.0.0.1'] };
  }
});

// 连接串口
ipcMain.handle('connect-serial', async (event, portPath, baudRate) => {
  try {
    if (serialPort && serialPort.isOpen) {
      await serialPort.close();
    }

    serialPort = new SerialPort({
      path: portPath,
      baudRate: baudRate || 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    });

    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    parser.on('data', (data) => {
      const parsedData = parseNMEA(data);
      if (parsedData && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-data', parsedData);

        // 更新Modbus服务器数据（添加节流控制）
        if (modbusServer && modbusServer.isRunning) {
          const now = Date.now();
          if (now - lastModbusUpdate >= MODBUS_UPDATE_INTERVAL) {
            lastModbusUpdate = now;
            parsedData.timezone = currentTimezoneOffset;
            modbusServer.updateBeidouData(parsedData);
          }
        }
      }
    });

    serialPort.on('error', (err) => {
      mainWindow.webContents.send('serial-error', err.message);
    });

    return { success: true, message: '串口连接成功' };
  } catch (error) {
    console.error('串口连接失败:', error);
    return { success: false, message: error.message };
  }
});

// 断开串口连接
ipcMain.handle('disconnect-serial', async () => {
  try {
    if (serialPort && serialPort.isOpen) {
      await serialPort.close();
      serialPort = null;
      parser = null;
    }
    return { success: true, message: '串口已断开' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// 解析NMEA数据
function parseNMEA(data) {
  const trimmedData = data.trim();
  if (!trimmedData.startsWith('$')) {
    return null;
  }

  const parts = trimmedData.split(',');
  const messageType = parts[0];

  // 根据GNSS系统选择过滤NMEA消息
  if (gnssSystem === 'beidou') {
    // 只接受北斗消息 ($BD...)
    if (!messageType.startsWith('$BD') && !messageType.startsWith('$GN')) {
      return null;
    }
  } else if (gnssSystem === 'gps') {
    // 只接受GPS消息 ($GP...)
    if (!messageType.startsWith('$GP') && !messageType.startsWith('$GN')) {
      return null;
    }
  }
  // gnssSystem === 'auto' 时接受所有消息

  let result = {
    type: messageType,
    raw: trimmedData,
    timestamp: Date.now(),
    gnssSystem: gnssSystem // 添加当前GNSS系统信息
  };

  // GPRMC - 推荐最小定位信息
  if (messageType === '$GPRMC' || messageType === '$GNRMC') {
    const time = parts[1];
    const status = parts[2];
    const latitude = parts[3];
    const latDirection = parts[4];
    const longitude = parts[5];
    const lonDirection = parts[6];
    const date = parts[9];

    if (time && date) {
      const hours = parseInt(time.substring(0, 2));
      const minutes = parseInt(time.substring(2, 4));
      const seconds = parseInt(time.substring(4, 6));
      const day = parseInt(date.substring(0, 2));
      const month = parseInt(date.substring(2, 4));
      const year = 2000 + parseInt(date.substring(4, 6));

      result.time = {
        hours,
        minutes,
        seconds,
        formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      };
      result.date = {
        year,
        month,
        day,
        formatted: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      };
    }

    if (status === 'A' && latitude && longitude) {
      result.position = {
        latitude: convertLatLon(latitude, latDirection),
        longitude: convertLatLon(longitude, lonDirection)
      };
      result.status = '有效';
    } else {
      result.status = '无效';
    }
  }

  // GPGGA - 定位定位数据
  if (messageType === '$GPGGA' || messageType === '$GNGGA') {
    const latitude = parts[2];
    const latDirection = parts[3];
    const longitude = parts[4];
    const lonDirection = parts[5];
    const quality = parseInt(parts[6]);
    const satellites = parseInt(parts[7]);
    const hdop = parseFloat(parts[8]);
    const altitude = parseFloat(parts[9]);
    const altUnit = parts[10];
    const geoid = parseFloat(parts[11]);
    const geoidUnit = parts[12];
    const time = parts[1];

    if (time) {
      const hours = parseInt(time.substring(0, 2));
      const minutes = parseInt(time.substring(2, 4));
      const seconds = parseInt(time.substring(4, 6));
      result.time = {
        hours,
        minutes,
        seconds,
        formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      };
    }

    if (latitude && longitude) {
      result.position = {
        latitude: convertLatLon(latitude, latDirection),
        longitude: convertLatLon(longitude, lonDirection)
      };
    }

    result.altitude = altitude ? altitude : 0;
    result.altitudeUnit = altUnit || 'M';
    result.satellites = satellites || 0;
    result.quality = quality;
    result.qualityDesc = getQualityDescription(quality);
    result.hdop = hdop || 0;
  }

  // GPGSV - 可视卫星数据
  if (messageType === '$GPGSV' || messageType === '$BDGSV') {
    const totalMessages = parseInt(parts[1]);
    const messageNumber = parseInt(parts[2]);
    const totalSatellites = parseInt(parts[3]);
    const satellitesInView = [];

    for (let i = 0; i < 4; i++) {
      const baseIndex = 4 + (i * 4);
      if (parts[baseIndex]) {
        satellitesInView.push({
          id: parseInt(parts[baseIndex]),
          elevation: parseInt(parts[baseIndex + 1]) || 0,
          azimuth: parseInt(parts[baseIndex + 2]) || 0,
          snr: parseInt(parts[baseIndex + 3]) || 0
        });
      }
    }

    result.gsv = {
      totalMessages,
      messageNumber,
      totalSatellites,
      satellitesInView
    };
  }

  // GPGSA - 当前卫星数据
  if (messageType === '$GPGSA' || messageType === '$BDGSA') {
    const mode = parts[1];
    const fixType = parseInt(parts[2]);
    const satIDs = [];
    for (let i = 3; i < 15; i++) {
      if (parts[i]) {
        satIDs.push(parseInt(parts[i]));
      }
    }
    const pdop = parseFloat(parts[15]);
    const hdop = parseFloat(parts[16]);
    const vdop = parseFloat(parts[17]);

    result.gsa = {
      mode,
      fixType,
      fixTypeDesc: getFixTypeDescription(fixType),
      satIDs,
      pdop: pdop || 0,
      hdop: hdop || 0,
      vdop: vdop || 0
    };
  }

  return result;
}

function convertLatLon(value, direction) {
  const degrees = parseInt(value.substring(0, value.length - 7));
  const minutes = parseFloat(value.substring(value.length - 7));
  let decimal = degrees + minutes / 60;
  if (direction === 'S' || direction === 'W') {
    decimal = -decimal;
  }
  return parseFloat(decimal.toFixed(6));
}

function getQualityDescription(quality) {
  const descriptions = [
    '无效定位',
    'GPS定位',
    'DGPS定位',
    'PPS定位',
    'RTK固定解',
    'RTK浮点解',
    '估计',
    '手动输入',
    '模拟模式'
  ];
  return descriptions[quality] || '未知';
}

function getFixTypeDescription(fixType) {
  const descriptions = [
    '无效',
    '2D定位',
    '3D定位',
    'GPS+DR',
    'RTK固定',
    'RTK浮点'
  ];
  return descriptions[fixType] || '未知';
}

// ========== Modbus TCP Server相关 ==========

// 启动Modbus TCP服务器
ipcMain.handle('start-modbus-server', async (event, port, host) => {
  try {
    if (modbusServer && modbusServer.isRunning) {
      await modbusServer.stop();
    }

    modbusServer = new ModbusTCPServer();
    const result = await modbusServer.start(port, host || '0.0.0.0');

    return {
      success: true,
      message: `Modbus TCP服务器已启动 (地址: ${host || '0.0.0.0'}, 端口: ${port})`,
      address: host || '0.0.0.0'
    };
  } catch (error) {
    console.error('启动Modbus服务器失败:', error);
    return { success: false, message: error.message };
  }
});

// 停止Modbus TCP服务器
ipcMain.handle('stop-modbus-server', async () => {
  try {
    if (modbusServer && modbusServer.isRunning) {
      await modbusServer.stop();
      modbusServer = null;
    }
    return { success: true, message: 'Modbus TCP服务器已停止' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// 获取Modbus服务器状态
ipcMain.handle('get-modbus-status', async () => {
  try {
    if (modbusServer) {
      return { success: true, status: modbusServer.getStatus() };
    }
    return { success: true, status: { isRunning: false } };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// ========== NTP Server相关 ==========

// 启动NTP服务器
ipcMain.handle('start-ntp-server', async (event, port, timezone, host) => {
  try {
    if (ntpServer && ntpServer.isRunning) {
      await ntpServer.stop();
    }

    ntpServer = new NTPServer();
    ntpServer.setBeidouOffset(timezone || 8);
    const result = await ntpServer.start(port, host || '0.0.0.0');

    return {
      success: true,
      message: `NTP服务器已启动 (地址: ${host || '0.0.0.0'}, 端口: ${port}, 时区: UTC${timezone >= 0 ? '+' : ''}${timezone})`,
      address: host || '0.0.0.0'
    };
  } catch (error) {
    console.error('启动NTP服务器失败:', error);
    return { success: false, message: error.message };
  }
});

// 停止NTP服务器
ipcMain.handle('stop-ntp-server', async () => {
  try {
    if (ntpServer && ntpServer.isRunning) {
      await ntpServer.stop();
      ntpServer = null;
    }
    return { success: true, message: 'NTP服务器已停止' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// 获取NTP服务器状态
ipcMain.handle('get-ntp-status', async () => {
  try {
    if (ntpServer) {
      return { success: true, status: ntpServer.getStatus() };
    }
    return { success: true, status: { isRunning: false } };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// 更新GNSS系统选择
ipcMain.handle('update-gnss-system', async (event, system) => {
  gnssSystem = system;
  console.log(`GNSS系统已更新: ${system === 'auto' ? '自动' : system === 'beidou' ? '北斗' : 'GPS'}`);
  return { success: true };
});

// 更新时区
ipcMain.handle('update-timezone', async (event, timezone) => {
  currentTimezoneOffset = timezone;
  console.log(`时区已更新: UTC${timezone >= 0 ? '+' : ''}${timezone}`);
  return { success: true };
});

// 应用退出时清理服务器
app.on('before-quit', async () => {
  if (modbusServer && modbusServer.isRunning) {
    await modbusServer.stop();
  }
  if (ntpServer && ntpServer.isRunning) {
    await ntpServer.stop();
  }
});
