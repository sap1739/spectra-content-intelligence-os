export { UnsupportedCapabilityError, assertCapability } from './publisher';
export type { CapabilityFlag, SocialPublisher } from './publisher';
export {
  DECLARED_CAPABILITY_VERSION,
  allPlatformCapabilities,
  getPlatformCapability,
} from './capabilities';
export { validateVariant } from './validation';
export type { ValidationIssue, VariantValidation, VariantValidationInput } from './validation';
export { SocialPublisherRegistry, socialPublisherRegistry } from './registry';
export type { PostPublisher, PublishInput, PublishOutcome } from './post-publisher';
export {
  AccountDiscoveryRegistry,
  accountDiscoveryRegistry,
  sanitizeDiscoveryMetadata,
} from './discovery';
export type {
  AccountDiscoveryPort,
  CapabilityDiscoveryPort,
  DestinationDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
  DiscoveryMetadata,
  IdentityDiscoveryPort,
} from './discovery';
