import { Module } from '@nestjs/common';

import { TransitionsService } from './transitions.service';

@Module({
  providers: [TransitionsService],
  exports: [TransitionsService],
})
export class TransitionsModule {}
