const net = require('net');
const os = require('os');

// 获取本机IP地址
function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过内部IP和非IPv4地址
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // 如果没有找到外部IP，使用回环地址
}

class ModbusTCPServer {
  constructor() {
    this.server = null;
    this.isRunning = false;
    this.port = 502;
    this.holdingRegisters = new Array(100).fill(0); // 保持寄存器
    this.inputRegisters = new Array(100).fill(0); // 输入寄存器
    this.clients = new Set(); // 客户端连接集合

    // 寄存器地址映射 (Modbus地址从1开始)
    this.regMap = {
      // 保持寄存器 (起始地址 1)
      DATE_YEAR: 1,           // 年 (4位)
      DATE_MONTH: 2,          // 月
      DATE_DAY: 3,           // 日
      TIME_HOUR: 4,          // 时 (UTC+8)
      TIME_MINUTE: 5,        // 分
      TIME_SECOND: 6,        // 秒
      ALTITUDE: 7,           // 海拔 (整数部分)
      ALTITUDE_DECIMAL: 8,   // 海拔 (小数部分, 精度0.1)
      LATITUDE_INT: 9,       // 纬度 (整数部分)
      LATITUDE_DECIMAL: 10,   // 纬度 (小数部分, 精度0.000001)
      LONGITUDE_INT: 11,     // 经度 (整数部分)
      LONGITUDE_DECIMAL: 12, // 经度 (小数部分, 精度0.000001)
      SAT_COUNT: 13,         // 卫星数量
      QUALITY: 14,           // 定位质量
      PDOP: 15,              // PDOP值 (整数部分)
      PDOP_DECIMAL: 16,      // PDOP值 (小数部分, 精度0.1)
      HDOP: 17,              // HDOP值 (整数部分)
      HDOP_DECIMAL: 18,      // HDOP值 (小数部分, 精度0.1)
      VDOP: 19,              // VDOP值 (整数部分)
      VDOP_DECIMAL: 20,      // VDOP值 (小数部分, 精度0.1)
      STATUS: 21,            // 定位状态 (0=无效, 1=有效)
      TIMEZONE: 22,          // 时区偏移 (UTC+/-小时)

      // 输入寄存器 (起始地址 1)
      TIMESTAMP: 1,          // 时间戳 (Unix时间戳)
      RAW_ALTITUDE: 2,       // 原始海拔值 (整数)
      RAW_LATITUDE: 3,       // 原始纬度值 (整数, 精度0.0001)
      RAW_LONGITUDE: 4,      // 原始经度值 (整数, 精度0.0001)
    };
  }

  // 启动Modbus TCP服务器
  start(port = 502, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      try {
        this.port = port;

        // 创建TCP服务器
        this.server = net.createServer((socket) => {
          // 优化TCP设置
          socket.setNoDelay(true); // 禁用Nagle算法，立即发送数据
          socket.setKeepAlive(true, 1000); // 启用TCP KeepAlive

          this.clients.add(socket);

          socket.on('data', (data) => {
            // 使用process.nextTick避免阻塞事件循环
            process.nextTick(() => {
              this.handleModbusRequest(socket, data);
            });
          });

          socket.on('error', (err) => {
            console.error('Modbus连接错误:', err);
            this.clients.delete(socket);
          });

          socket.on('close', () => {
            this.clients.delete(socket);
          });

          socket.on('end', () => {
            this.clients.delete(socket);
          });
        });

        // 优化服务器设置
        this.server.maxConnections = 100; // 最大连接数

        // 绑定到选择的IP和端口
        this.server.listen(port, host, () => {
          this.isRunning = true;
          const address = this.server.address();
          console.log(`Modbus TCP服务器已启动: ${address.address}:${address.port}`);
          resolve({ success: true, port: port, address: address.address });
        });

        this.server.on('error', (err) => {
          reject(err);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  // 停止Modbus TCP服务器
  stop() {
    return new Promise((resolve, reject) => {
      try {
        // 关闭所有客户端连接
        this.clients.forEach(client => {
          try {
            client.destroy();
          } catch (err) {
            // 忽略错误
          }
        });
        this.clients.clear();

        if (this.server && this.isRunning) {
          this.server.close(() => {
            this.isRunning = false;
            console.log('Modbus TCP服务器已停止');
            resolve({ success: true });
          });
        } else {
          resolve({ success: true });
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  // 处理Modbus请求
  handleModbusRequest(socket, data) {
    try {
      // 验证数据包最小长度
      if (data.length < 12) {
        console.error('Modbus请求数据包太短:', data.length);
        return;
      }

      // Modbus TCP MBAP Header (7 bytes)
      const transactionId = data.readUInt16BE(0);
      const protocolId = data.readUInt16BE(2);
      const length = data.readUInt16BE(4);
      const unitId = data.readUInt8(6);

      // 验证协议ID
      if (protocolId !== 0) {
        console.error('无效的Modbus协议ID:', protocolId);
        return;
      }

      // PDU
      const functionCode = data.readUInt8(7);

      let response = null;

      switch (functionCode) {
        case 0x03: // 读保持寄存器 (FC03)
          response = this.handleReadHoldingRegisters(data, 8);
          break;
        case 0x04: // 读输入寄存器 (FC04)
          response = this.handleReadInputRegisters(data, 8);
          break;
        case 0x06: // 写单个保持寄存器 (FC06)
          response = this.handleWriteSingleRegister(data, 8);
          break;
        default:
          // 返回异常码 0x01 (非法功能)
          response = Buffer.from([functionCode | 0x80, 0x01]);
          break;
      }

      if (response) {
        // 构造响应报文
        const mbapResponse = Buffer.allocUnsafe(7 + response.length);
        mbapResponse.writeUInt16BE(transactionId, 0);
        mbapResponse.writeUInt16BE(protocolId, 2);
        mbapResponse.writeUInt16BE(response.length, 4); // MBAP长度 = PDU长度
        mbapResponse.writeUInt8(unitId, 6);
        response.copy(mbapResponse, 7);

        // 确保数据完全发送
        socket.write(mbapResponse, () => {
          // 数据已发送
        });
      }
    } catch (error) {
      console.error('处理Modbus请求失败:', error);
    }
  }

  // 处理读保持寄存器 (FC03)
  handleReadHoldingRegisters(data, offset) {
    const startAddress = data.readUInt16BE(offset);
    const quantity = data.readUInt16BE(offset + 2);

    // 验证数量范围 (Modbus规范: 最多125个寄存器)
    if (quantity < 1 || quantity > 125) {
      return Buffer.from([0x03 | 0x80, 0x03]); // 异常码03: 非法数据值
    }

    // Modbus地址(1-based)转数组索引(0-based)
    const startIndex = startAddress - 1;

    // 快速构造响应
    const byteCount = quantity * 2;
    const response = Buffer.allocUnsafe(2 + byteCount);
    response.writeUInt8(0x03, 0);
    response.writeUInt8(byteCount, 1);

    // 直接复制寄存器数据
    for (let i = 0; i < quantity; i++) {
      const index = startIndex + i;
      const value = (index >= 0 && index < this.holdingRegisters.length)
        ? this.holdingRegisters[index]
        : 0;
      response.writeUInt16BE(value, 2 + i * 2);
    }

    return response;
  }

  // 处理读输入寄存器 (FC04)
  handleReadInputRegisters(data, offset) {
    const startAddress = data.readUInt16BE(offset);
    const quantity = data.readUInt16BE(offset + 2);

    // 验证数量范围
    if (quantity < 1 || quantity > 125) {
      return Buffer.from([0x04 | 0x80, 0x03]); // 异常码03: 非法数据值
    }

    // Modbus地址(1-based)转数组索引(0-based)
    const startIndex = startAddress - 1;

    // 快速构造响应
    const byteCount = quantity * 2;
    const response = Buffer.allocUnsafe(2 + byteCount);
    response.writeUInt8(0x04, 0);
    response.writeUInt8(byteCount, 1);

    // 直接复制输入寄存器数据
    for (let i = 0; i < quantity; i++) {
      const index = startIndex + i;
      const value = (index >= 0 && index < this.inputRegisters.length)
        ? this.inputRegisters[index]
        : 0;
      response.writeUInt16BE(value, 2 + i * 2);
    }

    return response;
  }

  // 处理写单个保持寄存器 (FC06)
  handleWriteSingleRegister(data, offset) {
    const address = data.readUInt16BE(offset);
    const value = data.readUInt16BE(offset + 2);

    // 验证地址范围
    if (address < 1 || address > 100) {
      return Buffer.from([0x06 | 0x80, 0x02]); // 异常码02: 非法数据地址
    }

    // Modbus地址(1-based)转数组索引(0-based)
    const arrayIndex = address - 1;

    if (arrayIndex >= 0 && arrayIndex < this.holdingRegisters.length) {
      this.holdingRegisters[arrayIndex] = value;
    }

    // 构造响应PDU: 功能码(1) + 地址(2) + 值(2)
    const response = Buffer.allocUnsafe(5);
    response.writeUInt8(0x06, 0);
    response.writeUInt16BE(address, 1);
    response.writeUInt16BE(value, 3);

    return response;
  }

  // 更新北斗数据到寄存器
  updateBeidouData(data) {
    try {
      // 更新日期时间 (Modbus地址转换为数组索引)
      if (data.date) {
        this.holdingRegisters[this.regMap.DATE_YEAR - 1] = data.date.year;
        this.holdingRegisters[this.regMap.DATE_MONTH - 1] = data.date.month;
        this.holdingRegisters[this.regMap.DATE_DAY - 1] = data.date.day;
      }

      if (data.time) {
        this.holdingRegisters[this.regMap.TIME_HOUR - 1] = data.time.hours;
        this.holdingRegisters[this.regMap.TIME_MINUTE - 1] = data.time.minutes;
        this.holdingRegisters[this.regMap.TIME_SECOND - 1] = data.time.seconds;
      }

      // 更新海拔
      if (data.altitude !== undefined) {
        this.holdingRegisters[this.regMap.ALTITUDE - 1] = Math.floor(data.altitude);
        this.holdingRegisters[this.regMap.ALTITUDE_DECIMAL - 1] = Math.round((data.altitude % 1) * 10);
      }

      // 更新经纬度
      if (data.position) {
        const lat = Math.abs(data.position.latitude);
        const lon = Math.abs(data.position.longitude);

        this.holdingRegisters[this.regMap.LATITUDE_INT - 1] = Math.floor(lat);
        this.holdingRegisters[this.regMap.LATITUDE_DECIMAL - 1] = Math.round((lat % 1) * 1000000);

        this.holdingRegisters[this.regMap.LONGITUDE_INT - 1] = Math.floor(lon);
        this.holdingRegisters[this.regMap.LONGITUDE_DECIMAL - 1] = Math.round((lon % 1) * 1000000);
      }

      // 更新卫星数量和质量
      if (data.satellites !== undefined) {
        this.holdingRegisters[this.regMap.SAT_COUNT - 1] = data.satellites;
      }

      if (data.quality !== undefined) {
        this.holdingRegisters[this.regMap.QUALITY - 1] = data.quality;
      }

      // 更新DOP值
      if (data.pdop !== undefined) {
        this.holdingRegisters[this.regMap.PDOP - 1] = Math.floor(data.pdop);
        this.holdingRegisters[this.regMap.PDOP_DECIMAL - 1] = Math.round((data.pdop % 1) * 10);
      }

      if (data.hdop !== undefined) {
        this.holdingRegisters[this.regMap.HDOP - 1] = Math.floor(data.hdop);
        this.holdingRegisters[this.regMap.HDOP_DECIMAL - 1] = Math.round((data.hdop % 1) * 10);
      }

      if (data.vdop !== undefined) {
        this.holdingRegisters[this.regMap.VDOP - 1] = Math.floor(data.vdop);
        this.holdingRegisters[this.regMap.VDOP_DECIMAL - 1] = Math.round((data.vdop % 1) * 10);
      }

      // 更新状态
      if (data.status) {
        this.holdingRegisters[this.regMap.STATUS - 1] = data.status === '有效' ? 1 : 0;
      }

      // 更新时区
      this.holdingRegisters[this.regMap.TIMEZONE - 1] = data.timezone || 8;

      // 更新输入寄存器 (Modbus地址转换为数组索引)
      this.inputRegisters[this.regMap.TIMESTAMP - 1] = Math.floor(Date.now() / 1000);

      if (data.altitude !== undefined) {
        this.inputRegisters[this.regMap.RAW_ALTITUDE - 1] = Math.round(data.altitude * 10);
      }

      if (data.position) {
        this.inputRegisters[this.regMap.RAW_LATITUDE - 1] = Math.round(Math.abs(data.position.latitude) * 10000);
        this.inputRegisters[this.regMap.RAW_LONGITUDE - 1] = Math.round(Math.abs(data.position.longitude) * 10000);
      }
    } catch (error) {
      console.error('更新Modbus寄存器失败:', error);
    }
  }

  // 获取服务器状态
  getStatus() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      holdingRegisters: this.holdingRegisters.slice(0, 30),
      inputRegisters: this.inputRegisters.slice(0, 10)
    };
  }
}

module.exports = ModbusTCPServer;
