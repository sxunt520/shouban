import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReminderKind, ReminderRepeat } from './contracts';

export class BindDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  pairingCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  characterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;
}

export class UpdateCharacterDto {
  @IsString()
  @IsNotEmpty()
  characterId: string;
}

export class UpdateCharacterPromptDto {
  @IsString()
  @MaxLength(8000)
  prompt: string;
}

export class BindCharacterNfcTagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  uid: string;
}

export class UpdateDeviceNameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name: string;
}

export class UpdateVolumeDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  volume: number;
}

export class CreateReminderDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  title: string;

  @IsISO8601()
  scheduledAt: string;

  @IsOptional()
  @IsIn(['none', 'daily'])
  repeat?: ReminderRepeat;

  @IsOptional()
  @IsIn(['reminder', 'alarm'])
  kind?: ReminderKind;
}

export class UpdateReminderDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsOptional()
  @IsIn(['none', 'daily'])
  repeat?: ReminderRepeat;

  @IsOptional()
  @IsIn(['reminder', 'alarm'])
  kind?: ReminderKind;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateAlarmDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  hour: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(59)
  minute: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days: number[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsBoolean()
  snoozeEnabled: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  snoozeMinutes: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  snoozeCount: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  themeId: string;

  @IsBoolean()
  useThemeSound: boolean;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  soundTitle: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  soundId?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(['Asia/Shanghai'])
  @MaxLength(64)
  timezone?: string;
}

export class UpdateAlarmDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  hour?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(59)
  minute?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  snoozeEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  snoozeMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  snoozeCount?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  themeId?: string;

  @IsOptional()
  @IsBoolean()
  useThemeSound?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  soundTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  soundId?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(['Asia/Shanghai'])
  @MaxLength(64)
  timezone?: string;
}

export class SynthesizeAlarmSoundDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  text: string;

  @IsOptional()
  @IsString()
  @IsIn(['morning-chime', 'soft-light'])
  backgroundMusicId?: string | null;
}

export class DeviceSessionDto {
  @IsString()
  @IsNotEmpty()
  hardwareId: string;

  @IsString()
  @IsNotEmpty()
  deviceSecret: string;
}

export class HeartbeatDto {
  @IsOptional()
  @IsString()
  firmwareVersion?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  volume?: number;
}

export class DeviceEventDto {
  @IsString()
  @IsNotEmpty()
  type: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class DeviceMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  clientRequestId?: string;
}

export class SpeakTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  text: string;
}
