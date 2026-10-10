去这里在线生成：https://mermaid.live/
把下面的copy过去
或者中文版的可以在线生成管理https://diagrama.cn


sequenceDiagram
    autonumber

    actor User as 用户
    participant App as RN + Expo APP
    participant Device as ESP32-S3 手办底座
    participant API as NestJS 后端
    participant database DB as MySQL数据库
    participant AI as 现有 AI 角色服务
    participant Voice as 阿里云 ASR / 音色复刻 TTS

    Note over App,DB: 当前已完成：设备绑定、角色关联、提醒、指令队列、设备状态、数据库持久化
    Note over Device,Voice: 硬件到货后接入：配网、音频采集播放、实时 ASR/TTS、屏幕表情

    rect rgb(245, 243, 255)
        Note over User,DB: 一、首次配网及账号绑定

        User->>App: 进入“添加手办底座”
        App->>Device: 通过 BLE 或设备热点发送 Wi-Fi 信息
        Device->>Device: 连接 2.4GHz Wi-Fi

        Device->>API: 创建设备会话<br/>hardwareId + deviceSecret
        API->>DB: 验证硬件编号和密钥哈希
        DB-->>API: 返回设备记录
        API->>DB: 保存设备 Token 哈希及过期时间
        API-->>Device: deviceToken + pairingCode
        Device-->>User: 屏幕显示绑定码

        User->>App: 输入绑定码并选择 AI 角色
        App->>API: 绑定设备<br/>userToken + pairingCode + characterId
        API->>DB: 保存账号、设备、角色关联
        API->>DB: 创建 sync_character 指令
        API-->>App: 返回绑定成功及设备资料

        Device->>API: 心跳并拉取待执行指令
        API->>DB: 更新 lastSeenAt
        API->>DB: 查询未确认指令
        DB-->>API: sync_character
        API-->>Device: 下发角色、音色和问候语
        Device->>API: ACK 指令执行成功
        API->>DB: 保存 acknowledgedAt
    end

    rect rgb(240, 249, 255)
        Note over User,Voice: 二、用户通过手办进行语音聊天

        User->>Device: 按键说话或说出唤醒词
        Device->>Device: 麦克风采集并编码为 Opus
        Device->>API: WebSocket 上传实时音频
        API->>Voice: 转发音频进行流式 ASR
        Voice-->>API: 返回中间识别结果
        API-->>Device: 屏幕显示“正在聆听”
        Voice-->>API: 返回最终识别文本

        API->>DB: 查询设备绑定的账号和角色
        DB-->>API: userId + characterId + voiceId
        API->>AI: 发送用户文本及角色上下文
        AI-->>API: 返回角色回复文本
        API->>DB: 保存或关联现有聊天记录

        API->>Voice: 使用角色 voiceId 合成语音
        Voice-->>API: 返回 TTS 音频流
        API-->>Device: 下发回复文本、表情和音频
        Device->>Device: 屏幕显示角色表情及文字
        Device-->>User: 喇叭播放角色音色回复

        Device->>API: 上报 playback_finished
        API->>DB: 保存播放完成事件
    end

    rect rgb(245, 255, 247)
        Note over User,Device: 三、用户在 APP 聊天并联动手办

        User->>App: 给 AI 角色发送文字或语音
        App->>API: 发送消息<br/>userToken + characterId
        API->>AI: 调用现有 AI 角色对话服务
        AI-->>API: 返回角色回复
        API->>DB: 保存聊天记录
        API-->>App: 返回文字及语音结果
        App-->>User: APP 展示和播放回复

        alt 用户开启“同步到手办”
            API->>DB: 创建 speak_text 指令
            Device->>API: 心跳或实时连接获取指令
            API-->>Device: text + characterId + voiceId
            Device->>API: 获取角色 TTS 音频
            API->>Voice: 请求音色复刻 TTS
            Voice-->>API: 返回音频
            API-->>Device: 返回音频流
            Device-->>User: 手办同步播报回复
            Device->>API: ACK 播报完成
        end
    end

    rect rgb(255, 249, 235)
        Note over User,DB: 四、闹钟和主动语音提醒

        User->>App: 创建提醒<br/>时间 + 内容 + 重复规则
        App->>API: POST /reminders
        API->>DB: 保存提醒
        API-->>App: 返回创建成功

        loop 后端定时任务
            API->>DB: 查询已到时间的提醒
            DB-->>API: 返回待触发提醒
        end

        alt 手办在线
            API->>Voice: 使用当前角色音色合成提醒
            Voice-->>API: 返回提醒音频
            API-->>Device: play_reminder + 音频 + 表情
            Device-->>User: 播放角色语音提醒
            User->>Device: 按键停止或稍后提醒
            Device->>API: 上报操作结果
            API->>DB: 更新提醒执行状态
        else 手办离线
            API->>DB: 保留待执行指令
            API-->>App: 标记设备离线或推送通知
        end
    end

    rect rgb(248, 248, 248)
        Note over App,DB: 五、设备状态同步

        loop 每 10～15 秒
            Device->>API: heartbeat<br/>固件版本 + 音量 + 网络状态
            API->>DB: 更新设备在线状态
        end

        App->>API: 查询设备状态
        API->>DB: 查询设备及当前角色
        DB-->>API: 在线状态、角色、音量、最后心跳
        API-->>App: 返回设备状态
        App-->>User: 展示在线、离线及当前角色
    end