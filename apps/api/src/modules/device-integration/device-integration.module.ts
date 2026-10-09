import { R1mNfcService } from './r1m-nfc.service';
import { R1mAccessService } from './r1m-access.service';
import { R1mControlService } from './r1m-control.service';
import { R1mController, R1mDeviceHttpController } from './r1m.controller';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceCommandEntity, DeviceEntity, DeviceEventEntity } from '../figure-companion/entities';
import { DeviceIntegrationService } from './device-integration.service';
import { PartnerMqttAdapter } from './partner-mqtt.adapter';

import { DeviceBootstrapController } from './device-bootstrap.controller';
import { DeviceBootstrapService } from './device-bootstrap.service';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceEntity, DeviceCommandEntity, DeviceEventEntity])],
  controllers: [DeviceBootstrapController, R1mController, R1mDeviceHttpController],
  providers: [R1mNfcService, R1mAccessService, R1mControlService, PartnerMqttAdapter, DeviceIntegrationService, DeviceBootstrapService],
  exports: [R1mNfcService, DeviceIntegrationService, PartnerMqttAdapter, R1mAccessService, R1mControlService],
})
export class DeviceIntegrationModule {}
