# 北斗卫星数据显示系统 - 手动运行指南

## 当前状态

系统已经创建了所有必要的文件，但需要重新安装依赖包才能运行。

## 安装步骤

### 1. 打开命令提示符或PowerShell

**方法1: 在项目文件夹中打开PowerShell**
- 进入项目文件夹: `C:\Users\anjee\CodeBuddy\20260128205243`
- 在文件夹空白处按住 `Shift` 键，右键点击
- 选择"在此处打开PowerShell窗口"

**方法2: 使用CMD**
- 按 `Win + R` 键
- 输入 `cmd` 并按回车
- 使用 `cd` 命令切换到项目目录:
  ```cmd
  cd C:\Users\anjee\CodeBuddy\20260128205243
  ```

### 2. 安装依赖

在命令行中执行以下命令之一：

**选项A: 使用npm (推荐)**
```cmd
npm install
```

**选项B: 使用pnpm**
```cmd
pnpm install
```

**选项C: 如果网络问题，使用国内镜像**
```cmd
npm install --registry=https://registry.npmmirror.com
```

**注意事项:**
- 安装过程可能需要5-10分钟
- 需要下载约200MB的数据
- 如果中途中断，请删除 `node_modules` 文件夹后重新安装

### 3. 运行程序

安装完成后，执行以下命令启动应用：

```cmd
npm start
```

或

```cmd
pnpm start
```

## 项目文件结构

```
beidou-satellite-display/
├── main.js              # Electron主进程
├── modbus-server.js      # Modbus TCP服务器
├── ntp-server.js         # NTP服务器
├── index.html            # 主界面HTML
├── renderer.js          # 前端渲染进程
├── styles.css           # 样式文件
├── package.json         # 项目配置和依赖
└── README.md           # 详细使用说明
```

## 功能说明

### 1. 北斗数据可视化
- 实时显示日期、时间、海拔、经纬度
- 卫星天空分布图
- 卫星信号强度显示
- DOP值（精度因子）

### 2. Modbus TCP Server
- 端口: 502 (可配置)
- 功能: 将北斗数据提供给Modbus客户端
- 寄存器: 保持寄存器 (0-99), 输入寄存器 (0-99)
- 使用场景: SCADA系统、工业自动化、数据采集

### 3. NTP Server
- 端口: 123 (可配置)
- 功能: 提供基于北斗GPS的时间同步服务
- 协议: NTP v3 (RFC 1305)
- 使用场景: 局域网时间同步、服务器时间校准

## 使用示例

### 连接北斗模块
1. 将北斗模块连接到电脑USB口
2. 在应用中点击"刷新"获取串口列表
3. 选择串口和波特率（通常是9600）
4. 点击"连接"

### 启动Modbus服务
1. 在左侧面板设置端口（默认502）
2. 点击"启动"按钮
3. 使用Modbus客户端工具测试连接

### 启动NTP服务
1. 在左侧面板设置端口（默认123）
2. 选择时区偏移（默认UTC+8）
3. 点击"启动"按钮
4. 使用NTP客户端测试时间同步

## 常见问题

### Q: npm install失败
**A:**
1. 检查网络连接
2. 尝试使用国内镜像源
3. 清除npm缓存: `npm cache clean --force`
4. 删除node_modules文件夹后重新安装

### Q: electron下载很慢
**A:**
1. 配置Electron镜像源:
   ```cmd
   npm config set electron_mirror https://cdn.npmmirror.com/binaries/electron/
   ```
2. 然后重新安装: `npm install`

### Q: 端口被占用无法启动服务
**A:**
1. 修改端口号（如5020、8123等）
2. 或停止占用端口的服务:
   - Windows: `netstat -ano | findstr :502`
   - 找到PID后: `taskkill /F /PID <PID>`
3. Windows系统使用1024以下端口需要管理员权限

### Q: 应用无法启动
**A:**
1. 检查依赖是否安装完整
2. 查看package.json中的main.js路径是否正确
3. 检查Node.js版本（需要v14.0+）
4. 查看控制台错误信息

## Modbus测试工具

推荐测试工具:
- **Modbus Poll**: Windows图形化工具
- **mbpoll**: 命令行工具
- **Modbus Slave Simulator**: 模拟器

## NTP测试工具

推荐测试工具:
- **w32tm**: Windows内置NTP客户端
- **ntpdate**: Linux命令行工具
- **NTP Server Monitor**: 图形化监控工具

## 技术支持

如遇问题，请检查:
1. Node.js版本: `node --version` (需要v14+)
2. npm版本: `npm --version` (需要v6+)
3. 查看README.md获取详细文档

## 许可证

MIT License
