import { R1mMqttVoiceService } from './r1m-mqtt-voice.service';
import { R1mVoiceService } from './r1m-voice.service';
import { PartnerVoiceService } from './partner-voice.service';
import { PartnerVoiceController } from './partner-voice.controller';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceAuthGuard, UserAuthGuard } from './auth.guards';
import { AuthController } from './auth.controller';
import { CharactersController } from './characters.controller';
import { DevicesController } from './devices.controller';
import { databaseEntities } from './entities';
import { HardwareController } from './hardware.controller';
import { RemindersController } from './reminders.controller';
import { StoreService } from './store.service';
import { TtsService } from './tts.service';
import { AudioController } from './audio.controller';
import { AsrService } from './asr.service';
import { AiChatService } from './ai-chat.service';
import { AlarmsController } from './alarms.controller';
import { AlarmSoundsController } from './alarm-sounds.controller';
import { AlarmSoundService } from './alarm-sound.service';
import { VoiceRecognitionHub } from './voice-recognition-hub';
import { DeviceIntegrationModule } from '../device-integration/device-integration.module';

@Module({
  imports: [TypeOrmModule.forFeature(databaseEntities), DeviceIntegrationModule],
  controllers: [
    PartnerVoiceController,
    AuthController,
    CharactersController,
    DevicesController,
    RemindersController,
    AlarmsController,
    AlarmSoundsController,
    HardwareController,
    AudioController,
  ],
  providers: [
    R1mVoiceService,
    R1mMqttVoiceService,
    PartnerVoiceService,
    StoreService,
    TtsService,
    AsrService,
    AiChatService,
    AlarmSoundService,
    VoiceRecognitionHub,
    UserAuthGuard,
    DeviceAuthGuard,
  ],
})
export class FigureCompanionModule {}
