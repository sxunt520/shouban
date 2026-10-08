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
import { CreateReminderDto, UpdateReminderDto } from './dto';
import { StoreService } from './store.service';

@Controller('reminders')
@UseGuards(UserAuthGuard)
export class RemindersController {
  constructor(private readonly store: StoreService) {}

  @Get()
  listReminders(
    @Req() request: UserRequest,
    @Query('deviceId') deviceId?: string,
  ) {
    return this.store.listReminders(request.user.id, deviceId);
  }

  @Post()
  createReminder(
    @Req() request: UserRequest,
    @Body() dto: CreateReminderDto,
  ) {
    return this.store.createReminder(request.user.id, dto);
  }

  @Patch(':reminderId')
  updateReminder(
    @Req() request: UserRequest,
    @Param('reminderId') reminderId: string,
    @Body() dto: UpdateReminderDto,
  ) {
    return this.store.updateReminder(request.user.id, reminderId, dto);
  }

  @Delete(':reminderId')
  deleteReminder(
    @Req() request: UserRequest,
    @Param('reminderId') reminderId: string,
  ) {
    return this.store.deleteReminder(request.user.id, reminderId);
  }
}
