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
