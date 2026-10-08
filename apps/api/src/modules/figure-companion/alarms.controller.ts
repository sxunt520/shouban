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
  UseGuards,
} from '@nestjs/common';
import { UserAuthGuard, UserRequest } from './auth.guards';
import { CreateAlarmDto, UpdateAlarmDto } from './dto';
import { StoreService } from './store.service';

@Controller('alarms')
@UseGuards(UserAuthGuard)
export class AlarmsController {
  constructor(private readonly store: StoreService) {}

  @Get()
  listAlarms(
    @Req() request: UserRequest,
    @Query('deviceId') deviceId?: string,
  ) {
    return this.store.listAlarms(request.user.id, deviceId);
  }

  @Post()
  createAlarm(@Req() request: UserRequest, @Body() dto: CreateAlarmDto) {
    return this.store.createAlarm(request.user.id, dto);
  }

  @Patch(':alarmId')
  updateAlarm(
    @Req() request: UserRequest,
    @Param('alarmId') alarmId: string,
    @Body() dto: UpdateAlarmDto,
  ) {
    return this.store.updateAlarm(request.user.id, alarmId, dto);
  }

  @Post(':alarmId/snooze')
  snoozeAlarm(
    @Req() request: UserRequest,
    @Param('alarmId') alarmId: string,
  ) {
    return this.store.snoozeAlarm(request.user.id, alarmId);
  }

  @Post(':alarmId/dismiss')
  dismissAlarm(
    @Req() request: UserRequest,
    @Param('alarmId') alarmId: string,
  ) {
    return this.store.dismissAlarm(request.user.id, alarmId);
  }

  @Delete(':alarmId')
  deleteAlarm(
    @Req() request: UserRequest,
    @Param('alarmId') alarmId: string,
  ) {
    return this.store.deleteAlarm(request.user.id, alarmId);
  }
}
