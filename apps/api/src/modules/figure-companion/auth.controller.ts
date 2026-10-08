import { Controller, Post } from '@nestjs/common';
import { StoreService } from './store.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly store: StoreService) {}

  @Post('demo')
  loginDemo() {
    return this.store.loginDemo();
  }
}
