import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { User } from './contracts';
import { DeviceEntity } from './entities';
import { StoreService } from './store.service';

export interface UserRequest extends Request {
  user: User;
}

export interface DeviceRequest extends Request {
  device: DeviceEntity;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(private readonly store: StoreService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<UserRequest>();
    const user = this.store.getUserForToken(readBearerToken(request));
    if (!user) throw new UnauthorizedException('登录状态无效');
    request.user = user;
    return true;
  }
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly store: StoreService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    const device = await this.store.getDeviceForToken(readBearerToken(request));
    if (!device) throw new UnauthorizedException('设备凭证无效');
    request.device = device;
    return true;
  }
}
