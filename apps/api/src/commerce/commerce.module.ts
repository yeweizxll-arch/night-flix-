import { Module } from '@nestjs/common';
import { NativeReceiptVerifier } from './native-receipt-verifier';
import { NativeStoreService } from './native-store.service';
import { CustomerNativeStoreController, NativeStoreWebhookController, TenantNativeStoreController } from './native-store.controller';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { AuthenticationModule } from '../auth/authentication.module';
import { ReferralModule } from '../referrals/referral.module';
import { CommerceCatalogService } from './commerce-catalog.service';
import {
  CustomerCommerceController,
  TenantCommerceCatalogController,
  TenantCommerceOrderController,
} from './commerce.controller';
import { CommerceOrderService } from './commerce-order.service';
import { FakePaymentAdapter, PaymentAdapterRegistry } from './payment-adapter';
import { PaymentConfigurationService } from './payment-configuration.service';
import { PaymentCoreService } from './payment-core.service';
import { PaymentSecretCipher } from './payment-secret-cipher';
import { CustomerPointUnlockController } from './point-unlock.controller';
import { PointUnlockService } from './point-unlock.service';
import { PlatformRefundController, TenantRefundController } from './refund.controller';
import { RefundService } from './refund.service';
import { StripePaymentAdapter } from './stripe-payment.adapter';
import { StripePaymentConfigurationService } from './stripe-payment-configuration.service';
import {
  CustomerPaymentController,
  PaymentWebhookController,
  PlatformPaymentConfigurationController,
  TenantPaymentConfigurationController,
} from './payment.controller';

@Module({
  imports: [CustomerAuthModule, ReferralModule, AuthenticationModule],
  controllers: [
    CustomerNativeStoreController, NativeStoreWebhookController, TenantNativeStoreController,
    TenantCommerceCatalogController,
    TenantCommerceOrderController,
    CustomerCommerceController,
    PlatformPaymentConfigurationController,
    TenantPaymentConfigurationController,
    CustomerPaymentController,
    PaymentWebhookController,
    CustomerPointUnlockController,
    TenantRefundController,
    PlatformRefundController,
  ],
  providers: [
    NativeReceiptVerifier, NativeStoreService,
    CommerceCatalogService,
    CommerceOrderService,
    FakePaymentAdapter,
    PaymentAdapterRegistry,
    PaymentConfigurationService,
    PaymentCoreService,
    {
      provide: PaymentSecretCipher,
      useFactory: () => new PaymentSecretCipher(),
    },
    PointUnlockService,
    RefundService,
    StripePaymentAdapter,
    StripePaymentConfigurationService,
    { provide: 'STRIPE_PAYMENT_ADAPTER', useExisting: StripePaymentAdapter },
  ],
  exports: [
    CommerceCatalogService,
    CommerceOrderService,
    PaymentConfigurationService,
    PaymentCoreService,
    StripePaymentConfigurationService,
    PointUnlockService,
    RefundService,
  ],
})
export class CommerceModule {}
