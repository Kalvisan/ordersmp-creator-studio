import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppAbility,
  PermissionsService,
} from '@gitroom/backend/services/auth/permissions/permissions.service';
import {
  AbilityPolicy,
  CHECK_POLICIES_KEY,
} from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { Organization } from '@prisma/client';
import { Request } from 'express';
import { SubscriptionException } from './permission.exception.class';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  CreatorPublishingGuard,
  CreatorRequest,
  isCreatorOwner,
} from './creator.publishing.guard';

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private _reflector: Reflector,
    private _authorizationService: PermissionsService,
    private _organizations: OrganizationService,
    private _posts: PostsService
  ) {}

  private readonly publishingReview = new CreatorPublishingGuard(
    async (id, hash, ttl) => {
      if (!process.env.REDIS_URL) return false;
      return (
        (await ioRedis.set(
          `creator-publish-approval:${id}`,
          hash,
          'EX',
          ttl,
          'NX'
        )) === 'OK'
      );
    }
  );

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    // This runs before the legacy anonymous/provider/subscription shortcuts.
    // Creator roles and publishing approval must not depend on Stripe settings.
    if (process.env.GOOGLE_ONLY_AUTH === 'true') {
      return this.checkCreatorRequest(request as CreatorRequest, context);
    }
    if (
      request.path.indexOf('/auth') > -1 ||
      request.path.indexOf('/auth') > -1 ||
      request.path.indexOf('/integrations/social-connect') > -1 ||
      request.path.indexOf('/integrations/provider') > -1
    ) {
      return true;
    }

    const policyHandlers =
      this._reflector.get<AbilityPolicy[]>(
        CHECK_POLICIES_KEY,
        context.getHandler()
      ) || [];

    if (!policyHandlers || !policyHandlers.length) {
      return true;
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    const { org }: { org: Organization } = request;

    const refreshChannelId =
      typeof request.query?.refresh === 'string'
        ? request.query.refresh
        : undefined;

    // @ts-ignore
    const ability = await this._authorizationService.check(
      org.id,
      org.createdAt,
      org.users[0].role,
      policyHandlers,
      refreshChannelId
    );

    const item = policyHandlers.find(
      (handler) => !this.execPolicyHandler(handler, ability)
    );

    if (item) {
      throw new SubscriptionException({
        section: item[1],
        action: item[0],
      });
    }

    return true;
  }

  private async checkCreatorRequest(
    request: CreatorRequest,
    context: ExecutionContext
  ) {
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    const deny = () =>
      new ForbiddenException('This action is unavailable for this account');
    if (controller === 'RootController' || controller === 'AuthController')
      return true;

    const publicApi = controller === 'PublicIntegrationsController';
    const publisherOrg = process.env.CREATOR_PUBLISHER_ORG_ID?.trim();
    if (publicApi) {
      if (!publisherOrg || request.org?.id !== publisherOrg) throw deny();
      const team = await this._organizations.getTeam(publisherOrg);
      if (
        !team?.users?.some(
          (member) =>
            !member.disabled &&
            member.role === 'SUPERADMIN' &&
            isCreatorOwner(member.user)
        )
      )
        throw deny();
      const allowed = [
        'getActiveIntegrations',
        'getPosts',
        'getMedia',
        'getMe',
        'listIntegration',
        'getIntegrationSettings',
        'uploadSimple',
        'createPost',
        'deletePost',
        'deletePostByGroup',
      ];
      if (!allowed.includes(handler)) throw deny();
      if (handler === 'createPost') {
        await this.checkExistingPosts(request, false);
        if (request.body?.type !== 'draft')
          await this.publishingReview.verifyApproval(request);
      }
      return true;
    }

    if (!request.user || !request.org?.id) throw deny();
    const role = request.org.users?.[0];
    const owner =
      isCreatorOwner(request.user) &&
      !role?.disabled &&
      (role?.role === 'ADMIN' || role?.role === 'SUPERADMIN');

    if (!owner) {
      if (!publisherOrg || request.org.id === publisherOrg) throw deny();
      const team = await this._organizations.getTeam(request.org.id);
      // A creator works only inside their sole-member organisation, even if
      // a forwarded invitation or stale membership exists elsewhere.
      if (
        team?.users?.length !== 1 ||
        team.users[0].disabled ||
        team.users[0].user.id !== request.user.id
      )
        throw deny();
      const allowed: Record<string, string[]> = {
        UsersController: ['getSelf', 'getOrgs', 'logout'],
        // Creator uploads and writes belong to the bounded portal library.
        // Native Postiz storage has no aggregate quota and shares host disk.
        MediaController: ['getMedia', 'getMediaStatus'],
        PostsController: [
          'getPosts',
          'getPostsList',
          'getPost',
          'getPostsByGroup',
          'getTags',
          'createPost',
          'deletePost',
        ],
      };
      if (!allowed[controller]?.includes(handler)) throw deny();
      if (controller === 'PostsController') {
        if (handler === 'createPost') {
          if (request.body?.type !== 'draft') throw deny();
          await this.checkExistingPosts(request, true);
        } else if (handler === 'deletePost') {
          this.requireDraft(
            await this._posts.getPostsByGroup(
              request.org.id,
              request.params.group
            )
          );
        }
      }
      return true;
    }

    // Owner reads and connection setup are explicit. Publishing generators,
    // RSS, plugs, arbitrary integration functions, native OAuth apps and
    // anonymous preview/agent endpoints stay closed in this prototype.
    if (controller === 'UsersController') {
      if (
        ![
          'getSelf',
          'getOrgs',
          'logout',
          'rotateApiKey',
          'getPersonalInformation',
          'getEmailNotifications',
          'updateEmailNotifications',
        ].includes(handler)
      )
        throw deny();
      return true;
    }
    if (controller === 'SettingsController') {
      if (
        ![
          'getTeam',
          'inviteTeamMember',
          'deleteTeamMember',
          'getShortlinkPreference',
        ].includes(handler)
      )
        throw deny();
      return true;
    }
    if (controller === 'NoAuthIntegrationsController') {
      if (
        !['getIntegrations', 'connectSocialMedia', 'saveProviderPage'].includes(
          handler
        )
      )
        throw deny();
      return true;
    }
    if (controller === 'IntegrationsController') {
      if (
        request.method !== 'GET' &&
        ![
          'saveProviderPage',
          'updateProviderSettings',
          'updateCustomerName',
          'updateIntegrationGroup',
          'updateOnCustomerName',
          'updateCustomName',
        ].includes(handler)
      )
        throw deny();
      return true;
    }
    if (controller === 'MediaController') {
      if (
        ![
          'getMedia',
          'getMediaStatus',
          'uploadServer',
          'uploadSimple',
          'deleteMedia',
          'saveMediaInformation',
        ].includes(handler)
      )
        throw deny();
      return true;
    }
    if (controller === 'PostsController') {
      if (handler === 'createPost') {
        await this.checkExistingPosts(request, false);
        if (request.body?.type !== 'draft')
          await this.publishingReview.verifyApproval(request);
      } else if (
        request.method !== 'GET' &&
        ![
          'deletePost',
          'createTag',
          'editTag',
          'deleteTag',
          'validatePosts',
          'shouldShortlink',
        ].includes(handler)
      )
        throw deny();
      return true;
    }
    if (controller === 'NotificationsController' && request.method === 'GET')
      return true;
    throw deny();
  }

  private requireDraft(result: { posts: { state: string }[] }) {
    if (
      !result?.posts?.length ||
      result.posts.some((post) => post.state !== 'DRAFT')
    ) {
      throw new ForbiddenException(
        'Only your draft submissions can be changed'
      );
    }
  }

  private async checkExistingPosts(
    request: CreatorRequest,
    draftOnly: boolean
  ) {
    if (
      !Array.isArray(request.body?.posts) ||
      !request.body.posts.length ||
      request.body.posts.length > 20
    ) {
      throw new ForbiddenException('A post submission is required');
    }
    // The legacy repository upsert uses a global post ID. Check every supplied
    // existing ID in the current organisation before any write reaches it.
    let totalValues = 0;
    for (const post of request.body.posts) {
      if (!post || typeof post !== 'object' || !Array.isArray(post.value))
        throw new ForbiddenException();
      totalValues += post.value.length;
      if (totalValues > 100)
        throw new ForbiddenException('Submit a smaller reviewed batch');
      if (post.group) {
        if (typeof post.group !== 'string') throw new ForbiddenException();
        const existing = await this._posts.getPostsByGroup(
          request.org!.id,
          post.group
        );
        if (draftOnly) this.requireDraft(existing);
      }
      for (const value of post.value) {
        if (!value || typeof value !== 'object') throw new ForbiddenException();
        if (value.id) {
          if (typeof value.id !== 'string') throw new ForbiddenException();
          const existing = await this._posts.getPost(request.org!.id, value.id);
          if (draftOnly) this.requireDraft(existing);
        }
      }
    }
  }

  private execPolicyHandler(handler: AbilityPolicy, ability: AppAbility) {
    return ability.can(handler[0], handler[1]);
  }
}
