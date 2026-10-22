import { IsString, Matches } from 'class-validator';

// LocalStorage.newFilePath writes dated folders and 32 random hexadecimal
// choices. A choice of 16 becomes "10", so the basename can be 32 to 64 chars.
export const NATIVE_UPLOAD_RELATIVE_PATH =
  /^20\d{2}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/[a-f0-9]{32,64}\.(?:jpg|jpeg|png|gif|webp|avif|bmp|tif|tiff|mp4|mp3|m4a|wav|ogg|opus)$/;

export class GetNativeUploadDto {
  @IsString()
  @Matches(NATIVE_UPLOAD_RELATIVE_PATH)
  relative: string;
}
