import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { UserAuthGuard, UserRequest } from './auth.guards';
import {
  BindDeviceDto,
  DeviceMessageDto,
  SpeakTextDto,
  UpdateCharacterDto,
  UpdateDeviceNameDto,
  UpdateVolumeDto,
} from './dto';
import { StoreService } from './store.service';

@Controller('devices')
@UseGuards(UserAuthGuard)
export class DevicesController {
  constructor(private readonly store: StoreService) {}

  @Get()
  listDevices(@Req() request: UserRequest) {
    return this.store.listDevices(request.user.id);
  }

  @Get(':deviceId')
  getDevice(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.store.getDevice(request.user.id, deviceId);
  }

  @Post('bind')
  bindDevice(@Req() request: UserRequest, @Body() dto: BindDeviceDto) {
    return this.store.bindDevice(request.user.id, dto);
  }

  @Delete(':deviceId/binding')
  unbindDevice(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.store.unbindDevice(request.user.id, deviceId);
  }

  @Patch(':deviceId/character')
  updateCharacter(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateCharacterDto,
  ) {
    return this.store.updateCharacter(
      request.user.id,
      deviceId,
      dto.characterId,
    );
  }

  @Patch(':deviceId/name')
  updateName(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateDeviceNameDto,
  ) {
    return this.store.updateDeviceName(request.user.id, deviceId, dto.name);
  }

  @Patch(':deviceId/volume')
  updateVolume(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateVolumeDto,
  ) {
    return this.store.updateVolume(request.user.id, deviceId, dto.volume);
  }

  @Post(':deviceId/speak')
  speakText(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: SpeakTextDto,
  ) {
    return this.store.speakText(request.user.id, deviceId, dto.text);
  }

  @Post(':deviceId/listen')
  startListening(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.store.startListening(request.user.id, deviceId);
  }

  @Get(':deviceId/commands')
  listCommands(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.store.listDeviceCommands(request.user.id, deviceId);
  }

  @Get(':deviceId/alarm-sync')
  alarmSyncStatus(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.store.getAlarmSyncStatus(request.user.id, deviceId);
  }

  @Post(':deviceId/alarm-sync')
  retryAlarmSync(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.store.retryAlarmSync(request.user.id, deviceId);
  }

  @Get(':deviceId/events')
  listEvents(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.store.listDeviceEvents(request.user.id, deviceId);
  }

  @Get(':deviceId/messages')
  listMessages(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.store.listConversationMessages(
      request.user.id,
      deviceId,
      before,
      limit ? Number(limit) : undefined,
    );
  }

  @Post(':deviceId/messages/stream')
  async streamMessage(
    @Req() request: UserRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: DeviceMessageDto,
    @Res() response: Response,
  ) {
    response.status(200);
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');

    const controller = new AbortController();
    const abort = () => controller.abort();
    // React Native's XMLHttpRequest can emit an early response `close` while
    // it is still waiting for streamed chunks. Treating that as cancellation
    // aborts the upstream AI request and leaves the app waiting forever.
    // `aborted` and response write errors represent actual broken requests.
    request.once('aborted', abort);
    response.once('error', abort);
    const emit = (event: Record<string, unknown>) => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`${JSON.stringify(event)}\n`);
      }
    };

    try {
      await this.store.streamAppConversationMessage(
        request.user.id,
        deviceId,
        dto.text,
        dto.clientRequestId,
        emit,
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : '流式对话失败',
        });
      }
    } finally {
      request.off('aborted', abort);
      response.off('error', abort);
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }
}
