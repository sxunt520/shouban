import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { databaseEntities } from './modules/figure-companion/entities';
import { FigureCompanionModule } from './modules/figure-companion/figure-companion.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      username: process.env.DB_USERNAME ?? 'root',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_DATABASE ?? 'shouban_companion',
      entities: databaseEntities,
      synchronize: process.env.DB_SYNCHRONIZE !== 'false',
      charset: 'utf8mb4',
      timezone: '+08:00',
      retryAttempts: 3,
      retryDelay: 1000,
    }),
    FigureCompanionModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
