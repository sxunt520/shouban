import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DeviceAuthGuard, DeviceRequest } from './auth.guards';
import {
  DeviceEventDto,
  DeviceMessageDto,
  DeviceSessionDto,
  HeartbeatDto,
} from './dto';
import { StoreService } from './store.service';

@Controller('device')
export class HardwareController {
  constructor(private readonly store: StoreService) {}

  @Post('session')
  createSession(@Body() dto: DeviceSessionDto) {
    return this.store.createDeviceSession(dto);
  }

  @Post('heartbeat')
  @UseGuards(DeviceAuthGuard)
  heartbeat(@Req() request: DeviceRequest, @Body() dto: HeartbeatDto) {
    return this.store.heartbeat(request.device, dto);
  }

  @Get('commands')
  @UseGuards(DeviceAuthGuard)
  listCommands(@Req() request: DeviceRequest) {
    return this.store.getPendingCommands(request.device);
  }

  @Post('commands/:commandId/ack')
  @UseGuards(DeviceAuthGuard)
  acknowledgeCommand(
    @Req() request: DeviceRequest,
    @Param('commandId') commandId: string,
  ) {
    return this.store.acknowledgeCommand(request.device, commandId);
  }

  @Post('events')
  @UseGuards(DeviceAuthGuard)
  receiveEvent(
    @Req() request: DeviceRequest,
    @Body() dto: DeviceEventDto,
  ) {
    return this.store.receiveDeviceEvent(request.device, dto.type, dto.payload);
  }

  @Post('conversation/messages')
  @UseGuards(DeviceAuthGuard)
  sendMessage(
    @Req() request: DeviceRequest,
    @Body() dto: DeviceMessageDto,
  ) {
    return this.store.replyToDeviceMessage(request.device, dto);
  }

  @Post('conversation/audio')
  @UseGuards(DeviceAuthGuard)
  uploadRecording(
    @Req() request: DeviceRequest,
    @Query('commandId') commandId: string,
  ) {
    return this.store.receiveDeviceRecording(
      request.device,
      commandId,
      request.body as unknown,
    );
  }
}
