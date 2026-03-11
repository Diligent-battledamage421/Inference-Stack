import { Module } from '@nestjs/common';
import { AudioController } from './audio.controller';
import { AudioService } from './audio.service';
import { WorkerOrchestratorModule } from '../worker-orchestrator/worker-orchestrator.module';

@Module({
  imports: [WorkerOrchestratorModule],
  controllers: [AudioController],
  providers: [AudioService],
})
export class AudioModule {}
