const dgram = require('dgram');
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

class NTPServer {
  constructor() {
    this.server = null;
    this.isRunning = false;
    this.port = 123;
    this.host = '0.0.0.0';
    this.actualAddress = getLocalIPAddress(); // 获取本机IP
    this.socket = null;

    // 北斗时间偏移（UTC+8，以秒为单位）
    this.beidouOffset = 8 * 3600;
  }

  // 启动NTP服务器
  start(port = 123, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      try {
        this.port = port;
        this.host = host;
        this.socket = dgram.createSocket('udp4');

        this.socket.on('error', (err) => {
          reject(err);
        });

        this.socket.on('message', (msg, rinfo) => {
          this.handleRequest(msg, rinfo);
        });

        this.socket.on('listening', () => {
          this.isRunning = true;
          this.actualAddress = host;
          console.log(`NTP服务器已启动: ${host}:${this.port}`);
          resolve({ success: true, port: port, address: host });
        });

        // 绑定到选择的IP地址
        this.socket.bind(port, host);

      } catch (error) {
        reject(error);
      }
    });
  }

  // 停止NTP服务器
  stop() {
    return new Promise((resolve, reject) => {
      try {
        if (this.socket && this.isRunning) {
          this.socket.close(() => {
            this.isRunning = false;
            console.log('NTP服务器已停止');
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

  // 处理NTP请求
  handleRequest(msg, rinfo) {
    try {
      // 解析NTP请求包
      const request = this.parseNTPPacket(msg);

      // 获取当前时间（使用北斗时间偏移）
      const now = this.getCurrentTime();

      // 构造NTP响应包
      const response = {
        li: 0,                        // 闰秒指示器（0：无警告）
        vn: 3,                        // 版本号（3：RFC 1305）
        mode: 4,                      // 模式（4：服务器）
        stratum: 1,                   // 层级（1：主时钟，使用北斗/GPS）
        poll: Math.min(10, Math.max(4, request.poll || 6)),
        precision: -20,               // 精度（2^-20秒，约1微秒）
        rootDelay: 0,                 // 根延迟
        rootDispersion: 0,           // 根离差
        referenceIdentifier: 'GPS',   // 参考标识符（GPS）
        referenceTimestamp: now,      // 参考时间戳（北斗/GPS时间）
        originateTimestamp: request.transmitTimestamp, // 起始时间戳
        receiveTimestamp: now,        // 接收时间戳
        transmitTimestamp: now       // 传输时间戳
      };

      // 序列化并发送响应
      const responseBuffer = this.serializeNTPPacket(response);
      this.socket.send(responseBuffer, rinfo.port, rinfo.address);

      console.log(`NTP请求来自 ${rinfo.address}:${rinfo.port}`);

    } catch (error) {
      console.error('处理NTP请求失败:', error);
    }
  }

  // 解析NTP数据包
  parseNTPPacket(buffer) {
    const byte1 = buffer[0];
    return {
      li: (byte1 >> 6) & 0x03,
      vn: (byte1 >> 3) & 0x07,
      mode: byte1 & 0x07,
      stratum: buffer[1],
      poll: buffer[2],
      precision: buffer[3],
      rootDelay: buffer.readUInt32BE(4) / 65536,
      rootDispersion: buffer.readUInt32BE(8) / 65536,
      referenceIdentifier: buffer.toString('ascii', 12, 16),
      referenceTimestamp: this.readTimestamp(buffer, 16),
      originateTimestamp: this.readTimestamp(buffer, 24),
      receiveTimestamp: this.readTimestamp(buffer, 32),
      transmitTimestamp: this.readTimestamp(buffer, 40)
    };
  }

  // 序列化NTP数据包
  serializeNTPPacket(packet) {
    const buffer = Buffer.alloc(48);

    // 第一个字节：LI、VN、Mode
    buffer[0] = ((packet.li & 0x03) << 6) |
                 ((packet.vn & 0x07) << 3) |
                 (packet.mode & 0x07);

    // 第二个字节：Stratum
    buffer[1] = packet.stratum;

    // Poll
    buffer[2] = packet.poll;

    // Precision
    buffer[3] = packet.precision;

    // Root Delay
    buffer.writeUInt32BE(Math.round(packet.rootDelay * 65536), 4);

    // Root Dispersion
    buffer.writeUInt32BE(Math.round(packet.rootDispersion * 65536), 8);

    // Reference Identifier
    buffer.write(packet.referenceIdentifier, 12, 4);

    // 时间戳
    this.writeTimestamp(buffer, 16, packet.referenceTimestamp);
    this.writeTimestamp(buffer, 24, packet.originateTimestamp);
    this.writeTimestamp(buffer, 32, packet.receiveTimestamp);
    this.writeTimestamp(buffer, 40, packet.transmitTimestamp);

    return buffer;
  }

  // 读取NTP时间戳（从1900年1月1日起的秒数）
  readTimestamp(buffer, offset) {
    const seconds = buffer.readUInt32BE(offset);
    const fraction = buffer.readUInt32BE(offset + 4);
    return {
      seconds: seconds,
      fraction: fraction,
      date: this.ntpToDate(seconds, fraction)
    };
  }

  // 写入NTP时间戳
  writeTimestamp(buffer, offset, timestamp) {
    buffer.writeUInt32BE(timestamp.seconds, offset);
    buffer.writeUInt32BE(timestamp.fraction, offset + 4);
  }

  // 将NTP时间戳转换为Date对象
  ntpToDate(seconds, fraction) {
    // NTP时间戳从1900年1月1日开始
    const ntpEpoch = Date.UTC(1900, 0, 1);
    const epochDiff = (Date.UTC(1970, 0, 1) - ntpEpoch) / 1000;

    const unixSeconds = seconds - epochDiff;
    const unixMs = unixSeconds * 1000 + (fraction / 4294967296) * 1000;

    return new Date(unixMs);
  }

  // 获取当前时间（带北斗偏移）
  getCurrentTime() {
    // 使用系统时间加上北斗偏移
    const now = new Date(Date.now() + this.beidouOffset * 1000);

    // 转换为NTP时间戳（从1900年1月1日起的秒数）
    const ntpEpoch = Date.UTC(1900, 0, 1);
    const epochDiff = (Date.UTC(1970, 0, 1) - ntpEpoch) / 1000;

    const seconds = Math.floor(now.getTime() / 1000) + epochDiff;
    const fraction = Math.round((now.getTime() % 1000) / 1000 * 4294967296);

    return {
      seconds: seconds,
      fraction: fraction,
      date: now
    };
  }

  // 设置北斗时间偏移
  setBeidouOffset(offsetHours) {
    this.beidouOffset = offsetHours * 3600;
  }

  // 获取服务器状态
  getStatus() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      host: this.host,
      address: this.actualAddress || this.host,
      beidouOffset: this.beidouOffset / 3600 // 转换为小时
    };
  }
}

module.exports = NTPServer;
