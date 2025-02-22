import { SignalService } from './../protobuf';
import { removeFromCache } from './cache';
import { EnvelopePlus } from './types';
import { getEnvelopeId } from './common';

import { PubKey } from '../session/types';
import { handleMessageJob } from './queuedJob';
import { downloadAttachment } from './attachments';
import _ from 'lodash';
import { StringUtils, UserUtils } from '../session/utils';
import { getConversationController } from '../session/conversations';
import { handleClosedGroupControlMessage } from './closedGroups';
import { MessageModel } from '../models/message';
import { MessageModelType } from '../models/messageType';
import {
  getMessageBySenderAndSentAt,
  getMessageBySenderAndServerTimestamp,
} from '../../ts/data/data';
import { ConversationModel, ConversationTypeEnum } from '../models/conversation';
import { allowOnlyOneAtATime } from '../session/utils/Promise';
import { toHex } from '../session/utils/String';
import { toLogFormat } from '../types/attachments/Errors';
import { processNewAttachment } from '../types/MessageAttachment';
import { MIME } from '../types';
import { autoScaleForIncomingAvatar } from '../util/attachmentsUtil';

export async function updateProfileOneAtATime(
  conversation: ConversationModel,
  profile: SignalService.DataMessage.ILokiProfile,
  profileKey?: Uint8Array | null // was any
) {
  if (!conversation?.id) {
    window?.log?.warn('Cannot update profile with empty convoid');
    return;
  }
  const oneAtaTimeStr = `updateProfileOneAtATime:${conversation.id}`;
  return allowOnlyOneAtATime(oneAtaTimeStr, async () => {
    return createOrUpdateProfile(conversation, profile, profileKey);
  });
}

/**
 * Creates a new profile from the profile provided. Creates the profile if it doesn't exist.
 */
async function createOrUpdateProfile(
  conversation: ConversationModel,
  profile: SignalService.DataMessage.ILokiProfile,
  profileKey?: Uint8Array | null
) {
  const { dcodeIO, textsecure } = window;

  // Retain old values unless changed:
  const newProfile = conversation.get('profile') || {};

  newProfile.displayName = profile.displayName;

  if (profile.profilePicture && profileKey) {
    const prevPointer = conversation.get('avatarPointer');
    const needsUpdate = !prevPointer || !_.isEqual(prevPointer, profile.profilePicture);

    if (needsUpdate) {
      try {
        const downloaded = await downloadAttachment({
          url: profile.profilePicture,
          isRaw: true,
        });

        // null => use placeholder with color and first letter
        let path = null;
        if (profileKey) {
          // Convert profileKey to ArrayBuffer, if needed
          const encoding = typeof profileKey === 'string' ? 'base64' : null;
          try {
            const profileKeyArrayBuffer = dcodeIO.ByteBuffer.wrap(
              profileKey,
              encoding
            ).toArrayBuffer();
            const decryptedData = await textsecure.crypto.decryptProfile(
              downloaded.data,
              profileKeyArrayBuffer
            );

            const scaledData = await autoScaleForIncomingAvatar(decryptedData);
            const upgraded = await processNewAttachment({
              data: await scaledData.blob.arrayBuffer(),
              contentType: MIME.IMAGE_UNKNOWN, // contentType is mostly used to generate previews and screenshot. We do not care for those in this case.
            });
            // Only update the convo if the download and decrypt is a success
            conversation.set('avatarPointer', profile.profilePicture);
            conversation.set('profileKey', toHex(profileKey));
            ({ path } = upgraded);
          } catch (e) {
            window?.log?.error(`Could not decrypt profile image: ${e}`);
          }
        }
        newProfile.avatar = path;
      } catch (e) {
        window.log.warn(
          `Failed to download attachment at ${profile.profilePicture}. Maybe it expired? ${e.message}`
        );
        // do not return here, we still want to update the display name even if the avatar failed to download
      }
    }
  } else if (profileKey) {
    newProfile.avatar = null;
  }

  const conv = await getConversationController().getOrCreateAndWait(
    conversation.id,
    ConversationTypeEnum.PRIVATE
  );
  await conv.setLokiProfile(newProfile);
  await conv.commit();
}

function cleanAttachment(attachment: any) {
  return {
    ..._.omit(attachment, 'thumbnail'),
    id: attachment.id.toString(),
    key: attachment.key ? StringUtils.decode(attachment.key, 'base64') : null,
    digest:
      attachment.digest && attachment.digest.length > 0
        ? StringUtils.decode(attachment.digest, 'base64')
        : null,
  };
}

function cleanAttachments(decrypted: any) {
  const { quote, group } = decrypted;

  // Here we go from binary to string/base64 in all AttachmentPointer digest/key fields

  if (group && group.type === SignalService.GroupContext.Type.UPDATE) {
    if (group.avatar !== null) {
      group.avatar = cleanAttachment(group.avatar);
    }
  }

  decrypted.attachments = (decrypted.attachments || []).map(cleanAttachment);
  decrypted.preview = (decrypted.preview || []).map((item: any) => {
    const { image } = item;

    if (!image) {
      return item;
    }

    return {
      ...item,
      image: cleanAttachment(image),
    };
  });

  if (quote) {
    if (quote.id) {
      quote.id = _.toNumber(quote.id);
    }

    quote.attachments = (quote.attachments || []).map((item: any) => {
      const { thumbnail } = item;

      if (!thumbnail || thumbnail.length === 0) {
        return item;
      }

      return {
        ...item,
        thumbnail: cleanAttachment(item.thumbnail),
      };
    });
  }
}

export async function processDecrypted(
  envelope: EnvelopePlus,
  decrypted: SignalService.IDataMessage
) {
  /* tslint:disable:no-bitwise */
  const FLAGS = SignalService.DataMessage.Flags;

  // Now that its decrypted, validate the message and clean it up for consumer
  //   processing
  // Note that messages may (generally) only perform one action and we ignore remaining
  //   fields after the first action.

  if (decrypted.flags == null) {
    decrypted.flags = 0;
  }
  if (decrypted.expireTimer == null) {
    decrypted.expireTimer = 0;
  }
  if (decrypted.flags & FLAGS.EXPIRATION_TIMER_UPDATE) {
    decrypted.body = '';
    decrypted.attachments = [];
  } else if (decrypted.flags !== 0) {
    throw new Error('Unknown flags in message');
  }

  if (decrypted.group) {
    // decrypted.group.id = new TextDecoder('utf-8').decode(decrypted.group.id);

    switch (decrypted.group.type) {
      case SignalService.GroupContext.Type.UPDATE:
        decrypted.body = '';
        decrypted.attachments = [];
        break;
      case SignalService.GroupContext.Type.QUIT:
        decrypted.body = '';
        decrypted.attachments = [];
        break;
      case SignalService.GroupContext.Type.DELIVER:
        decrypted.group.name = null;
        decrypted.group.members = [];
        decrypted.group.avatar = null;
        break;
      case SignalService.GroupContext.Type.REQUEST_INFO:
        decrypted.body = '';
        decrypted.attachments = [];
        break;
      default:
        await removeFromCache(envelope);
        throw new Error('Unknown group message type');
    }
  }

  const attachmentCount = decrypted?.attachments?.length || 0;
  const ATTACHMENT_MAX = 32;
  if (attachmentCount > ATTACHMENT_MAX) {
    await removeFromCache(envelope);
    throw new Error(
      `Too many attachments: ${attachmentCount} included in one message, max is ${ATTACHMENT_MAX}`
    );
  }

  cleanAttachments(decrypted);

  // if the decrypted dataMessage timestamp is not set, copy the one from the envelope
  if (!_.toNumber(decrypted?.timestamp)) {
    decrypted.timestamp = envelope.timestamp;
  }

  return decrypted as SignalService.DataMessage;
  /* tslint:disable:no-bitwise */
}

export function isMessageEmpty(message: SignalService.DataMessage) {
  const { flags, body, attachments, group, quote, preview, openGroupInvitation } = message;

  return (
    !flags &&
    // FIXME remove this hack to drop auto friend requests messages in a few weeks 15/07/2020
    isBodyEmpty(body) &&
    _.isEmpty(attachments) &&
    _.isEmpty(group) &&
    _.isEmpty(quote) &&
    _.isEmpty(preview) &&
    _.isEmpty(openGroupInvitation)
  );
}

function isBodyEmpty(body: string) {
  return _.isEmpty(body);
}

/**
 * We have a few origins possible
 *    - if the message is from a private conversation with a friend and he wrote to us,
 *        the conversation to add the message to is our friend pubkey, so envelope.source
 *    - if the message is from a medium group conversation
 *        * envelope.source is the medium group pubkey
 *        * envelope.senderIdentity is the author pubkey (the one who sent the message)
 *    - at last, if the message is a syncMessage,
 *        * envelope.source is our pubkey (our other device has the same pubkey as us)
 *        * dataMessage.syncTarget is either the group public key OR the private conversation this message is about.
 */
export async function handleDataMessage(
  envelope: EnvelopePlus,
  dataMessage: SignalService.IDataMessage,
  messageHash: string
): Promise<void> {
  // we handle group updates from our other devices in handleClosedGroupControlMessage()
  if (dataMessage.closedGroupControlMessage) {
    await handleClosedGroupControlMessage(
      envelope,
      dataMessage.closedGroupControlMessage as SignalService.DataMessage.ClosedGroupControlMessage
    );
    return;
  }

  const message = await processDecrypted(envelope, dataMessage);
  const source = dataMessage.syncTarget || envelope.source;
  const senderPubKey = envelope.senderIdentity || envelope.source;
  const isMe = UserUtils.isUsFromCache(senderPubKey);
  const isSyncMessage = Boolean(dataMessage.syncTarget?.length);

  window?.log?.info(`Handle dataMessage from ${source} `);

  if (isSyncMessage && !isMe) {
    window?.log?.warn('Got a sync message from someone else than me. Dropping it.');
    return removeFromCache(envelope);
  } else if (isSyncMessage && dataMessage.syncTarget) {
    // override the envelope source
    envelope.source = dataMessage.syncTarget;
  }

  const senderConversation = await getConversationController().getOrCreateAndWait(
    senderPubKey,
    ConversationTypeEnum.PRIVATE
  );

  // Check if we need to update any profile names
  if (!isMe && senderConversation && message.profile) {
    // do not await this
    void updateProfileOneAtATime(senderConversation, message.profile, message.profileKey);
  }
  if (isMessageEmpty(message)) {
    window?.log?.warn(`Message ${getEnvelopeId(envelope)} ignored; it was empty`);
    return removeFromCache(envelope);
  }

  // Data messages for medium groups don't arrive as sync messages. Instead,
  // linked devices poll for group messages independently, thus they need
  // to recognise some of those messages at their own.
  const messageEventType: 'sent' | 'message' = isMe ? 'sent' : 'message';

  if (envelope.senderIdentity) {
    message.group = {
      id: envelope.source as any, // FIXME Uint8Array vs string
    };
  }

  const confirm = () => removeFromCache(envelope);

  const data: MessageCreationData = {
    source: senderPubKey,
    destination: isMe ? message.syncTarget : envelope.source,
    sourceDevice: 1,
    timestamp: _.toNumber(envelope.timestamp),
    receivedAt: envelope.receivedAt,
    message,
    messageHash,
    isPublic: false,
    serverId: null,
    serverTimestamp: null,
  };

  await handleMessageEvent(messageEventType, data, confirm);
}

type MessageDuplicateSearchType = {
  body: string;
  id: string;
  timestamp: number;
  serverId?: number;
};

export type MessageId = {
  source: string;
  serverId?: number | null;
  serverTimestamp?: number | null;
  sourceDevice: number;
  timestamp: number;
  message: MessageDuplicateSearchType;
};
const PUBLICCHAT_MIN_TIME_BETWEEN_DUPLICATE_MESSAGES = 10 * 1000; // 10s

export async function isMessageDuplicate({
  source,
  timestamp,
  message,
  serverTimestamp,
}: MessageId) {
  // serverTimestamp is only used for opengroupv2
  try {
    let result;

    if (serverTimestamp) {
      // first try to find a duplicate with the same serverTimestamp from this sender

      result = await getMessageBySenderAndServerTimestamp({
        source,
        serverTimestamp,
      });

      // if we have a result, it means a specific user sent two messages either with the same serverTimestamp.
      // no need to do anything else, those messages must be the same
      // Note: this test is not based on which conversation the user sent the message
      // but we consider that a user sending two messages with the same serverTimestamp is unlikely
      return Boolean(result);
    }
    result = await getMessageBySenderAndSentAt({
      source,
      sentAt: timestamp,
    });

    if (!result) {
      return false;
    }
    const filteredResult = [result].filter((m: any) => m.attributes.body === message.body);
    return filteredResult.some(m => isDuplicate(m, message, source));
  } catch (error) {
    window?.log?.error('isMessageDuplicate error:', toLogFormat(error));
    return false;
  }
}

export const isDuplicate = (
  m: MessageModel,
  testedMessage: MessageDuplicateSearchType,
  source: string
) => {
  // The username in this case is the users pubKey
  const sameUsername = m.attributes.source === source;
  const sameText = m.attributes.body === testedMessage.body;
  // Don't filter out messages that are too far apart from each other
  const timestampsSimilar =
    Math.abs(m.attributes.sent_at - testedMessage.timestamp) <=
    PUBLICCHAT_MIN_TIME_BETWEEN_DUPLICATE_MESSAGES;

  return sameUsername && sameText && timestampsSimilar;
};

async function handleProfileUpdate(
  profileKeyBuffer: Uint8Array,
  convoId: string,
  isIncoming: boolean
) {
  if (!isIncoming) {
    // We update our own profileKey if it's different from what we have
    const ourNumber = UserUtils.getOurPubKeyStrFromCache();
    const me = getConversationController().getOrCreate(ourNumber, ConversationTypeEnum.PRIVATE);

    // Will do the save for us if needed
    await me.setProfileKey(profileKeyBuffer);
  } else {
    const sender = await getConversationController().getOrCreateAndWait(
      convoId,
      ConversationTypeEnum.PRIVATE
    );

    // Will do the save for us
    await sender.setProfileKey(profileKeyBuffer);
  }
}

export type MessageCreationData = {
  timestamp: number;
  receivedAt: number;
  sourceDevice: number; // always 1 for Session
  source: string;
  message: any;
  isPublic: boolean;
  serverId: number | null;
  serverTimestamp: number | null;

  // Needed for synced outgoing messages
  expirationStartTimestamp?: any; // ???
  destination: string;
  messageHash: string;
};

export function initIncomingMessage(data: MessageCreationData): MessageModel {
  const {
    timestamp,
    isPublic,
    receivedAt,
    sourceDevice,
    source,
    serverId,
    message,
    serverTimestamp,
    messageHash,
  } = data;

  const messageGroupId = message?.group?.id;
  const groupIdWithPrefix = messageGroupId && messageGroupId.length > 0 ? messageGroupId : null;
  let groupId: string | undefined;
  if (groupIdWithPrefix) {
    groupId = PubKey.removeTextSecurePrefixIfNeeded(groupIdWithPrefix);
  }

  const messageData: any = {
    source,
    sourceDevice,
    serverId,
    sent_at: timestamp,
    serverTimestamp,
    received_at: receivedAt || Date.now(),
    conversationId: groupId ?? source,
    type: 'incoming',
    direction: 'incoming', // +
    unread: 1,
    isPublic,
    messageHash: messageHash || null,
  };

  return new MessageModel(messageData);
}

function createSentMessage(data: MessageCreationData): MessageModel {
  const now = Date.now();

  const {
    timestamp,
    serverTimestamp,
    serverId,
    isPublic,
    receivedAt,
    sourceDevice,
    expirationStartTimestamp,
    destination,
    message,
    messageHash,
  } = data;

  const sentSpecificFields = {
    sent_to: [],
    sent: true,
    expirationStartTimestamp: Math.min(expirationStartTimestamp || data.timestamp || now, now),
  };

  const messageGroupId = message?.group?.id;
  const groupIdWithPrefix = messageGroupId && messageGroupId.length > 0 ? messageGroupId : null;
  let groupId: string | undefined;
  if (groupIdWithPrefix) {
    groupId = PubKey.removeTextSecurePrefixIfNeeded(groupIdWithPrefix);
  }

  const messageData = {
    source: UserUtils.getOurPubKeyStrFromCache(),
    sourceDevice,
    serverTimestamp: serverTimestamp || undefined,
    serverId: serverId || undefined,
    sent_at: timestamp,
    received_at: isPublic ? receivedAt : now,
    isPublic,
    conversationId: groupId ?? destination,
    type: 'outgoing' as MessageModelType,
    messageHash,
    ...sentSpecificFields,
  };

  return new MessageModel(messageData);
}

export function createMessage(data: MessageCreationData, isIncoming: boolean): MessageModel {
  if (isIncoming) {
    return initIncomingMessage(data);
  } else {
    return createSentMessage(data);
  }
}

// tslint:disable:cyclomatic-complexity max-func-body-length */
async function handleMessageEvent(
  messageEventType: 'sent' | 'message',
  data: MessageCreationData,
  confirm: () => void
): Promise<void> {
  const isIncoming = messageEventType === 'message';

  if (!data || !data.message) {
    window?.log?.warn('Invalid data passed to handleMessageEvent.', event);
    confirm();
    return;
  }

  const { message, destination, messageHash } = data;

  let { source } = data;

  const isGroupMessage = Boolean(message.group);

  const type = isGroupMessage ? ConversationTypeEnum.GROUP : ConversationTypeEnum.PRIVATE;

  let conversationId = isIncoming ? source : destination || source; // for synced message
  if (!conversationId) {
    window?.log?.error('We cannot handle a message without a conversationId');
    confirm();
    return;
  }
  if (message.profileKey?.length) {
    await handleProfileUpdate(message.profileKey, conversationId, isIncoming);
  }

  const msg = createMessage(data, isIncoming);

  // if the message is `sent` (from secondary device) we have to set the sender manually... (at least for now)
  source = source || msg.get('source');

  // Conversation Id is:
  //  - primarySource if it is an incoming DM message,
  //  - destination if it is an outgoing message,
  //  - group.id if it is a group message
  if (isGroupMessage) {
    // remove the prefix from the source object so this is correct for all other
    message.group.id = PubKey.removeTextSecurePrefixIfNeeded(message.group.id);

    conversationId = message.group.id;
  }

  if (!conversationId) {
    window?.log?.warn('Invalid conversation id for incoming message', conversationId);
  }
  const ourNumber = UserUtils.getOurPubKeyStrFromCache();

  // =========================================

  if (!isGroupMessage && source !== ourNumber) {
    // Ignore auth from our devices
    conversationId = source;
  }

  const conversation = await getConversationController().getOrCreateAndWait(conversationId, type);

  if (!conversation) {
    window?.log?.warn('Skipping handleJob for unknown convo: ', conversationId);
    confirm();
    return;
  }

  void conversation.queueJob(async () => {
    if (await isMessageDuplicate(data)) {
      window?.log?.info('Received duplicate message. Dropping it.');
      confirm();
      return;
    }
    await handleMessageJob(msg, conversation, message, ourNumber, confirm, source, messageHash);
  });
}
