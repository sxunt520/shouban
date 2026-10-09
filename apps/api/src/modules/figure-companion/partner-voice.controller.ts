import { BadRequestException, Body, Controller, Get, Header, Param, Post, Req, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserAuthGuard, UserRequest } from './auth.guards';
import { PartnerVoiceService } from './partner-voice.service';

@Controller('devices/:deviceId/voice')
@UseGuards(UserAuthGuard)
export class PartnerVoiceController {
  constructor(private readonly voice: PartnerVoiceService) {}
  @Get() status(@Req() r: UserRequest, @Param('deviceId') id: string) { return this.voice.status(r.user.id, id); }
  @Post('test-text') text(@Req() r: UserRequest, @Param('deviceId') id: string, @Body() body: { text?: unknown }) { return this.voice.testInput(r.user.id, id, { text: body?.text }); }
  @Post('test-audio')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 400000, files: 1 } }))
  audio(@Req() r: UserRequest, @Param('deviceId') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('请上传 WAV 录音');
    return this.voice.testInput(r.user.id, id, { wav: file.buffer });
  }
  @Post('abort') abort(@Req() r: UserRequest, @Param('deviceId') id: string) { return this.voice.abort(r.user.id, id); }
  @Get('audio/:sessionId') @Header('Cache-Control', 'no-store')
  async preview(@Req() r: UserRequest, @Param('deviceId') id: string, @Param('sessionId') session: string) {
    return new StreamableFile(await this.voice.cachedAudio(r.user.id, id, session), { type: 'audio/wav' });
  }
}
