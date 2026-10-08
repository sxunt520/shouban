import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserAuthGuard, UserRequest } from './auth.guards';
import { AlarmSoundService } from './alarm-sound.service';
import { SynthesizeAlarmSoundDto } from './dto';
import { StoreService } from './store.service';

@Controller('alarm-sounds')
@UseGuards(UserAuthGuard)
export class AlarmSoundsController {
  constructor(
    private readonly sounds: AlarmSoundService,
    private readonly store: StoreService,
  ) {}

  @Get()
  list(@Req() request: UserRequest) {
    return this.sounds.list(request.user.id);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024 } }))
  upload(
    @Req() request: UserRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('title') title?: string,
  ) {
    return this.sounds.uploadSource(request.user.id, file, title);
  }

  @Post(':soundId/synthesize')
  synthesize(
    @Req() request: UserRequest,
    @Param('soundId') soundId: string,
    @Body() dto: SynthesizeAlarmSoundDto,
  ) {
    return this.sounds.startSynthesis(request.user.id, soundId, dto);
  }

  @Get(':soundId/audio')
  @Header('Cache-Control', 'private, max-age=86400')
  async audio(
    @Req() request: UserRequest,
    @Param('soundId') soundId: string,
  ) {
    const audio = await this.sounds.readForUser(request.user.id, soundId);
    return new StreamableFile(audio.buffer, {
      type: 'audio/wav',
      length: audio.size,
    });
  }

  @Get(':soundId/playback-url')
  playbackUrl(
    @Req() request: UserRequest,
    @Param('soundId') soundId: string,
  ) {
    return this.sounds.playbackUrlForUser(request.user.id, soundId);
  }

  @Delete(':soundId')
  async delete(
    @Req() request: UserRequest,
    @Param('soundId') soundId: string,
  ) {
    const result = await this.sounds.delete(request.user.id, soundId);
    for (const deviceId of result.affectedDeviceIds) {
      await this.store.queueAlarmSyncForDevice(deviceId, request.user.id);
    }
    const { affectedDeviceIds: _affectedDeviceIds, ...response } = result;
    return response;
  }
}
