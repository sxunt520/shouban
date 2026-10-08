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

@Module({
  imports: [TypeOrmModule.forFeature(databaseEntities)],
  controllers: [
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
