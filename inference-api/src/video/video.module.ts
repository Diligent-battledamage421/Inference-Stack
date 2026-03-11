import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { WorkerOrchestratorModule } from '../worker-orchestrator/worker-orchestrator.module';

@Module({
  imports: [WorkerOrchestratorModule],
  controllers: [VideoController],
  providers: [VideoService],
})
export class VideoModule {}
