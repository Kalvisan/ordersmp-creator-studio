import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization, User } from '@prisma/client';
import type { Role } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { GetNativeUploadDto } from '@gitroom/nestjs-libraries/dtos/media/get.native.upload.dto';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ApiTags } from '@nestjs/swagger';
import handleR2Upload from '@gitroom/nestjs-libraries/upload/r2.uploader';
import { FileInterceptor } from '@nestjs/platform-express';
import { streamUploadOptions } from '@gitroom/nestjs-libraries/upload/multer.stream.engine';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { SaveMediaInformationDto } from '@gitroom/nestjs-libraries/dtos/media/save.media.information.dto';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';
import { VideoFunctionDto } from '@gitroom/nestjs-libraries/dtos/videos/video.function.dto';

@ApiTags('Media')
@Controller('/media')
export class MediaController {
  private storage = UploadFactory.createStorage();
  constructor(
    private _mediaService: MediaService,
    private _subscriptionService: SubscriptionService
  ) {}

  @Delete('/:id')
  deleteMedia(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._mediaService.deleteMedia(org.id, id);
  }

  @Post('/generate-video')
  generateVideo(
    @GetOrgFromRequest() org: Organization,
    @Body() body: VideoDto
  ) {
    console.log('hello');
    return this._mediaService.generateVideo(org, body);
  }

  @Post('/generate-image')
  async generateImage(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Body('prompt') prompt: string,
    isPicturePrompt = false
  ) {
    const total = await this._subscriptionService.checkCredits(org);
    if (process.env.STRIPE_PUBLISHABLE_KEY && total.credits <= 0) {
      return false;
    }

    return {
      output:
        'data:image/png;base64,' +
        (await this._mediaService.generateImage(prompt, org, isPicturePrompt)),
    };
  }

  @Post('/generate-image-with-prompt')
  async generateImageFromText(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Body('prompt') prompt: string
  ) {
    const image = await this.generateImage(org, req, prompt, true);
    if (!image) {
      return false;
    }

    const file = await this.storage.uploadSimple(image.output);

    return this._mediaService.saveFile(org.id, file.split('/').pop(), file);
  }

  @Post('/upload-server')
  @UseInterceptors(FileInterceptor('file', streamUploadOptions()))
  async uploadServer(
    @GetOrgFromRequest() org: Organization,
    @UploadedFile() file: Express.Multer.File
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this._mediaService.saveFile(
      org.id,
      file.filename,
      file.path,
      file.originalname
    );
  }

  @Post('/save-media')
  async saveMedia(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Body('name') name: string,
    @Body('originalName') originalName: string
  ) {
    if (!name) {
      return false;
    }
    return this._mediaService.saveFile(
      org.id,
      name,
      process.env.CLOUDFLARE_BUCKET_URL + '/' + name,
      originalName || undefined
    );
  }

  @Post('/information')
  saveMediaInformation(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SaveMediaInformationDto
  ) {
    return this._mediaService.saveMediaInformation(org.id, body);
  }

  @Post('/upload-simple')
  @UseInterceptors(FileInterceptor('file', streamUploadOptions()))
  async uploadSimple(
    @GetOrgFromRequest() org: Organization,
    @UploadedFile('file') file: Express.Multer.File,
    @Body('preventSave') preventSave: string = 'false'
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (preventSave === 'true') {
      return { path: file.path };
    }

    return this._mediaService.saveFile(
      org.id,
      file.filename,
      file.path,
      file.originalname
    );
  }

  @Post('/:endpoint')
  async uploadFile(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Res() res: Response,
    @Param('endpoint') endpoint: string
  ) {
    const upload = await handleR2Upload(endpoint, req, res);
    // a rejected or failed completion has already answered with its own status
    if (endpoint !== 'complete-multipart-upload' || res.headersSent) {
      return upload;
    }

    // @ts-ignore
    const name = upload.Location.split('/').pop();
    const originalName = req.body?.file?.name;

    const saveFile = await this._mediaService.saveUploadedFile(
      org.id,
      name,
      // @ts-ignore
      upload.Location,
      originalName || undefined
    );

    res.status(200).json({ ...upload, saved: saveFile });
  }

  @Get('/:id/status')
  getMediaStatus(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._mediaService.getMediaStatus(org.id, id);
  }

  @Get('/native-upload')
  async lookupNativeUpload(
    @GetOrgFromRequest()
    org: Organization & { users: { role: Role; disabled?: boolean }[] },
    @GetUserFromRequest() user: User,
    @Query() query: GetNativeUploadDto
  ) {
    const owner = process.env.GOOGLE_AUTH_OWNER_EMAIL?.trim().toLowerCase();
    const member = org.users?.[0];
    if (
      process.env.GOOGLE_ONLY_AUTH !== 'true' ||
      !owner ||
      user.email?.trim().toLowerCase() !== owner ||
      member?.disabled ||
      !['ADMIN', 'SUPERADMIN'].includes(member?.role)
    ) {
      throw new ForbiddenException(
        'Only the channel owner can read native uploads'
      );
    }
    return {
      registered: await this._mediaService.isRegisteredNativeUpload(
        org.id,
        query.relative
      ),
    };
  }

  @Get('/')
  getMedia(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page: number,
    @Query('search') search?: string
  ) {
    return this._mediaService.getMedia(org.id, page, search);
  }

  @Get('/video-options')
  getVideos() {
    return this._mediaService.getVideoOptions();
  }

  @Post('/video/function')
  videoFunction(@Body() body: VideoFunctionDto) {
    return this._mediaService.videoFunction(
      body.identifier,
      body.functionName,
      body.params
    );
  }

  @Get('/generate-video/:type/allowed')
  generateVideoAllowed(
    @GetOrgFromRequest() org: Organization,
    @Param('type') type: string
  ) {
    return this._mediaService.generateVideoAllowed(org, type);
  }
}
