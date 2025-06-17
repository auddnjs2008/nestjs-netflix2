import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';
import { PagePaginationDto } from './dto/page-pagination.dto';
import { CursorPaginationDto } from './dto/cursor-pagination.dto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ObjectCannedACL, PutObjectCommand, S3 } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import { ConfigService } from '@nestjs/config';
import { envVariableKeys } from './const/env.const';

@Injectable()
export class CommonService {
  private s3: S3;

  constructor(private readonly configService: ConfigService) {
    this.s3 = new S3({
      credentials: {
        accessKeyId: configService.get(envVariableKeys.awsAccessKeyId),
        secretAccessKey: configService.get(envVariableKeys.awsSecretAccessKey),
      },

      region: configService.get(envVariableKeys.awsRegion),
    });
  }

  async saveMovieToPermanentStorage(fileName: string) {
    try {
      const bucketName = this.configService.get<string>(
        envVariableKeys.bucketName,
      );
      await this.s3.copyObject({
        CopySource: `${bucketName}/public/temp/${fileName}`,
        Bucket: bucketName,
        Key: `public/movie/${fileName}`,
        ACL: 'public-read',
      });

      await this.s3.deleteObject({
        Bucket: bucketName,
        Key: `public/temp/${fileName}`,
      });
    } catch (e) {
      console.log(e);
      throw new InternalServerErrorException('s3 error');
    }
  }

  async createPresignedUrl(expiresIn = 300) {
    const params = {
      Bucket: this.configService.get(envVariableKeys.bucketName),
      Key: `public/temp/${uuid()}.mp4`,
      ACL: ObjectCannedACL.public_read,
    };

    try {
      const url = await getSignedUrl(this.s3, new PutObjectCommand(params), {
        expiresIn,
      });
      return url;
    } catch (error) {
      console.log(error);
      throw new InternalServerErrorException('S3 presigned url 생성 실패');
    }
  }

  applyPagePaginationParamsToQb<T>(
    qb: SelectQueryBuilder<T>,
    dto: PagePaginationDto,
  ) {
    const { page, take } = dto;
    const skip = (page - 1) * take;
    qb.take(take);
    qb.skip(skip);
  }

  async applyCursorPaginationParamsToQb<T>(
    qb: SelectQueryBuilder<T>,
    dto: CursorPaginationDto,
  ) {
    let { order } = dto;
    const { cursor, take } = dto;

    if (cursor) {
      const decodedCursor = Buffer.from(cursor, 'base64').toString('utf-8');
      const cursorObj = JSON.parse(decodedCursor);

      order = cursorObj.order;

      const { values } = cursorObj;

      /// (column1 , column2, column3) > (:value1, :value2, :value3)
      const columns = Object.keys(values);
      const comparisonOperator = order.some((o) => o.endsWith('DESC'))
        ? '<'
        : '>';

      const whereConditions = columns.map((c) => `${qb.alias}.${c}`).join(',');
      const whereParams = columns.map((c) => `:${c}`).join(',');

      qb.where(
        `(${whereConditions}) ${comparisonOperator} (${whereParams})`,
        values,
      );
    }

    for (let i = 0; i < order.length; i++) {
      const [column, direction] = order[i].split('_');

      if (direction !== 'ASC' && direction !== 'DESC') {
        throw new BadRequestException(
          'order는 ASC 또는 DESC 로 끝나야 합니다.',
        );
      }

      if (i === 0) {
        qb.orderBy(`${qb.alias}.${column}`, direction);
      } else {
        qb.addOrderBy(`${qb.alias}.${column}`, direction);
      }
    }

    qb.take(take);

    const results = await qb.getMany();

    const nextCursor = this.generateNextCursor(results, order);

    return { qb, nextCursor };
  }

  generateNextCursor<T>(results: T[], order: string[]): string | null {
    if (results.length === 0) return null;

    /**
     *  {
     *   values: {
     *    id: 1,
     *    likeCount: 10,
     *   },
     *   order: [id_DESC,likeCount_DESC]
     * }
     */

    const lastItem = results[results.length - 1];

    const values = {};

    order.forEach((columnOrder) => {
      const [column] = columnOrder.split('_');
      values[column] = lastItem[column];
    });

    const cursorObj = { values, order };
    const nextCursor = Buffer.from(JSON.stringify(cursorObj)).toString(
      'base64',
    );

    return nextCursor;
  }
}
