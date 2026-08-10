'use strict';

const CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  accounts: true,
  search: true,
  friendRequests: true,
  friendRequestNotifications: true,
  reciprocalFriendApproval: true,
  presence: true,
  presenceStates: Object.freeze(['online', 'offline', 'away', 'invisible']),
  textMessages: true,
  groups: true,
  discussions: true,
  groupInvitations: true,
  mobileGroupManagement: true,
  virtualGroupReplies: true,
  storage: 'sqlite',
  userProfiles: true,
  virtualUsers: true,
  globalMemory: true,
  openAICompatibleProviders: true,
  localAdmin: true,
  media: Object.freeze({
    signaling: true,
    images: true,
    voice: true,
    video: false,
    senderTransport: 'legacy TCP negotiation plus HTTP range upload',
    receiverTransport: 'chat link to gateway image/AMR page',
    storage: 'sqlite-blob',
  }),
});

module.exports = { CAPABILITIES };
