import {
  Controller,
  Get,
  Header,
  Param,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { DeviceAuthGuard, DeviceRequest } from './auth.guards';
import { AlarmSoundService } from './alarm-sound.service';
import { TtsService } from './tts.service';

@Controller('audio')
@UseGuards(DeviceAuthGuard)
export class AudioController {
  constructor(
    private readonly tts: TtsService,
    private readonly alarmSounds: AlarmSoundService,
  ) {}

  @Get('alarm/:soundId')
  @Header('Cache-Control', 'private, max-age=86400')
  async getAlarmAudio(
    @Req() request: DeviceRequest,
    @Param('soundId') soundId: string,
  ) {
    const audio = await this.alarmSounds.readForDevice(
      request.device.ownerUserId,
      soundId,
    );
    return new StreamableFile(audio.buffer, {
      type: 'audio/wav',
      length: audio.size,
    });
  }

  @Get(':fileName')
  @Header('Cache-Control', 'private, max-age=86400')
  async getAudio(@Param('fileName') fileName: string) {
    const audio = await this.tts.readCachedAudio(fileName);
    return new StreamableFile(audio.buffer, {
      type: 'audio/wav',
      length: audio.size,
    });
  }
}
