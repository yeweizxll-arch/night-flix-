import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';
import 'package:night_flix/src/native_purchases.dart';

class PurchaseRepository extends DramaRepository {
  PurchaseRepository() : super(apiBaseUrl: 'https://tenant.test');
  Completer<void>? verification;
  bool reject = false;
  int confirmations = 0;
  @override
  Future<String> nativePurchaseBinding(
    String accessToken, {
    String? store,
    String? productId,
  }) async => '018f2f45-7f5e-7e70-b17f-f6e773573101';
  @override
  Future<String> confirmNativePurchase(
    String store,
    String productId,
    String receipt,
    String accessToken,
  ) async {
    confirmations++;
    await verification?.future;
    if (reject) throw const ApiException('Invalid receipt', 403);
    return 'active';
  }
}

class TestStore extends Fake implements InAppPurchase {
  final events = StreamController<List<PurchaseDetails>>.broadcast();
  final completed = <PurchaseDetails>[];
  String? kind;
  PurchaseParam? params;
  bool? autoConsume;
  String? restoredBinding;
  @override
  Stream<List<PurchaseDetails>> get purchaseStream => events.stream;
  @override
  Future<bool> buyConsumable({
    required PurchaseParam purchaseParam,
    bool autoConsume = true,
  }) async {
    kind = 'consumable';
    params = purchaseParam;
    this.autoConsume = autoConsume;
    return true;
  }

  @override
  Future<bool> buyNonConsumable({required PurchaseParam purchaseParam}) async {
    kind = 'membership';
    params = purchaseParam;
    return true;
  }

  @override
  Future<void> completePurchase(PurchaseDetails purchase) async {
    completed.add(purchase);
  }

  @override
  Future<void> restorePurchases({String? applicationUserName}) async {
    restoredBinding = applicationUserName;
  }
}

ProductDetails product(String id) => ProductDetails(
  id: id,
  title: id,
  description: '',
  price: '\$1.99',
  rawPrice: 1.99,
  currencyCode: 'USD',
);
PurchaseDetails event(
  String id, {
  PurchaseStatus status = PurchaseStatus.purchased,
}) => PurchaseDetails(
  purchaseID: id,
  productID: 'coins',
  verificationData: PurchaseVerificationData(
    localVerificationData: '',
    serverVerificationData: 'signed-proof',
    source: 'app_store',
  ),
  transactionDate: '1800000000000',
  status: status,
)..pendingCompletePurchase = true;
Future<void> flush() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  late PurchaseRepository repo;
  late AppController controller;
  late TestStore store;
  late NativePurchases purchases;
  setUp(() async {
    repo = PurchaseRepository()
      ..session = const UserSession(
        accessToken: 'a',
        refreshToken: 'r',
        email: 'a@test.com',
        accountId: 'A',
      );
    controller = AppController(repo)
      ..config = AppRuntimeConfig.fromJson({
        'storeProducts': {
          'apple': [
            {'id': 'coins', 'kind': 'points_topup'},
            {'id': 'member', 'kind': 'membership'},
          ],
        },
      });
    store = TestStore();
    purchases = NativePurchases(controller, store: store, android: false);
    await flush(); // Initial inventory restoration finishes before a deliberate new purchase.
  });
  tearDown(() async {
    purchases.dispose();
    controller.dispose();
    await store.events.close();
  });
  test(
    'uses account binding and distinguishes consumables from subscriptions',
    () async {
      await purchases.buy(product('coins'));
      expect(store.kind, 'consumable');
      expect(store.autoConsume, false);
      expect(
        store.params!.applicationUserName,
        '018f2f45-7f5e-7e70-b17f-f6e773573101',
      );
      store.events.add([event('cancel', status: PurchaseStatus.canceled)]);
      await flush();
      await purchases.buy(product('member'));
      expect(store.kind, 'membership');
    },
  );
  test('only completes after durable server confirmation and deduplicates callback events', () async {
    repo.verification = Completer<void>();
    final purchase = event('paid-1');
    store.events.add([purchase, purchase]);
    await flush();
    expect(store.completed, isEmpty);
    repo.verification!.complete();
    await flush();
    expect(store.completed, [purchase]);
    expect(repo.confirmations, 1);
    expect(purchases.confirmed, true);
  });
  test('failed verification stays unfinished and restore retries the original transaction', () async {
    repo.reject = true;
    final purchase = event('retry');
    store.events.add([purchase]);
    await flush();
    expect(purchases.error, true);
    expect(store.completed, isEmpty);
    await purchases.restore();
    expect(store.restoredBinding, isNotNull);
    repo.reject = false;
    store.events.add([purchase]);
    await flush();
    expect(store.completed, [purchase]);
    expect(purchases.confirmed, true);
  });
  test('switching accounts while verification is pending cannot finish a previous account purchase', () async {
    repo.verification = Completer<void>();
    store.events.add([event('account-a')]);
    await flush();
    controller.session = const UserSession(
      accessToken: 'b',
      refreshToken: 'b',
      email: 'b@test.com',
      accountId: 'B',
    );
    repo.verification!.complete();
    await flush();
    expect(store.completed, isEmpty);
    expect(purchases.confirmed, false);
  });
}
