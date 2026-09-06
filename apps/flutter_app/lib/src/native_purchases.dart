import 'dart:async';
import 'dart:io';
import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';

import 'app_strings.dart';
import 'drama_repository.dart';

final _purchases = Expando<NativePurchases>();
NativePurchases? purchasesFor(AppController controller) =>
    _purchases[controller];

class NativePurchases extends ChangeNotifier {
  NativePurchases(this.controller, {InAppPurchase? store, bool? android})
    : android = android ?? Platform.isAndroid {
    _store = store;
    _purchases[controller] = this;
    if (!controller.repository.demoMode && products.isNotEmpty) {
      _subscription = (store ?? this.store).purchaseStream.listen(
        (events) {
          for (final purchase in events) {
            _queue = _queue
                .catchError((Object _) {})
                .then((_) => _receive(purchase));
          }
        },
        onError: (Object _) {
          error = true;
          busy = false;
          _notify();
        },
      );
      controller.addListener(_sessionChanged);
      scheduleMicrotask(_sessionChanged);
    }
  }
  final AppController controller;
  InAppPurchase? _store;
  InAppPurchase get store => _store ??= InAppPurchase.instance;
  final bool android;
  StreamSubscription<List<PurchaseDetails>>? _subscription;
  Future<void> _queue = Future.value();
  final Set<String> _completed = {};
  bool _disposed = false;
  bool busy = false;
  bool error = false;
  bool confirmed = false;
  String? _restoredScope;
  void _sessionChanged() {
    if (_disposed || busy || controller.session == null) return;
    if (_restoredScope == controller.accountScope) return;
    _restoredScope = controller.accountScope;
    unawaited(restore());
  }

  String get platform => android ? 'google' : 'apple';
  Map<String, String> get products => {
    for (final item in controller.config.storeProducts[platform] as List? ?? [])
      if (item is Map &&
          item['id'] is String &&
          ['points_topup', 'membership'].contains(item['kind']))
        item['id'] as String: item['kind'] as String,
  };

  Future<void> buy(ProductDetails product) async {
    if (busy || !products.containsKey(product.id)) return;
    final scope = controller.accountScope;
    final session = controller.session;
    if (session == null) return;
    busy = true;
    error = false;
    confirmed = false;
    _notify();
    try {
      final binding = await controller.repository.nativePurchaseBinding(
        session.accessToken,
        store: platform,
        productId: product.id,
      );
      if (_disposed || controller.accountScope != scope) {
        busy = false;
        _notify();
        return;
      }
      final params = PurchaseParam(
        productDetails: product,
        applicationUserName: binding,
      );
      final started = products[product.id] == 'points_topup'
          ? await store.buyConsumable(purchaseParam: params, autoConsume: false)
          : await store.buyNonConsumable(purchaseParam: params);
      if (!started) {
        busy = false;
        error = true;
        _notify();
      }
    } catch (_) {
      busy = false;
      error = true;
      _notify();
    }
  }

  Future<void> restore() async {
    final session = controller.session;
    if (session == null || busy) return;
    final scope = controller.accountScope;
    busy = true;
    error = false;
    _notify();
    try {
      final binding = await controller.repository.nativePurchaseBinding(
        session.accessToken,
      );
      if (_disposed || controller.accountScope != scope) return;
      await store.restorePurchases(applicationUserName: binding);
    } catch (_) {
      error = true;
    } finally {
      busy = false;
      _notify();
      if (controller.accountScope != scope) _sessionChanged();
    }
  }

  Future<void> _receive(PurchaseDetails purchase) async {
    if (_disposed) return;
    if (purchase.status == PurchaseStatus.pending) {
      busy = true;
      _notify();
      return;
    }
    if (purchase.status == PurchaseStatus.error ||
        purchase.status == PurchaseStatus.canceled) {
      busy = false;
      error = purchase.status == PurchaseStatus.error;
      _notify();
      return;
    }
    final scope = controller.accountScope;
    final session = controller.session;
    if (session == null) {
      busy = false;
      _notify();
      return;
    }
    final key =
        '$scope:${purchase.productID}:${purchase.purchaseID ?? sha256.convert(utf8.encode(purchase.verificationData.serverVerificationData))}';
    if (_completed.contains(key)) return;
    try {
      if (!products.containsKey(purchase.productID)) {
        throw StateError('Product mapping missing');
      }
      final status = await controller.repository.confirmNativePurchase(
        platform,
        purchase.productID,
        purchase.verificationData.serverVerificationData,
        session.accessToken,
      );
      if (_disposed || controller.accountScope != scope) return;
      // Do not acknowledge/consume before the server durably grants or rejects the purchase.
      if (purchase.pendingCompletePurchase) {
        await store.completePurchase(purchase);
      }
      if (android && products[purchase.productID] == 'points_topup') {
        final result = await store
            .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>()
            .consumePurchase(purchase);
        if (result.responseCode != BillingResponse.ok &&
            result.responseCode != BillingResponse.itemNotOwned) {
          throw StateError('Consumption retry required');
        }
      }
      if (controller.accountScope == scope) {
        _completed.add(key);
        if (_completed.length > 1000) _completed.remove(_completed.first);
        confirmed = status == 'active';
        error = false;
      }
    } catch (_) {
      if (controller.accountScope == scope) error = true;
    } finally {
      busy = false;
      _notify();
      if (controller.accountScope != scope) _sessionChanged();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_sessionChanged);
    if (_purchases[controller] == this) _purchases[controller] = null;
    unawaited(_subscription?.cancel());
    super.dispose();
  }
}

class NativePurchaseScope extends InheritedNotifier<NativePurchases> {
  const NativePurchaseScope({
    super.key,
    required NativePurchases purchases,
    required super.child,
  }) : super(notifier: purchases);
  static NativePurchases? of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<NativePurchaseScope>()
      ?.notifier;
}

Future<void> showNativeStore(
  BuildContext context,
  NativePurchases purchases,
) async {
  if (purchases.products.isEmpty || !await purchases.store.isAvailable()) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            context.tr(
              'storeUnavailable',
              'Store unavailable. Please try again later.',
            ),
          ),
        ),
      );
    }
    return;
  }
  final response = await purchases.store.queryProductDetails(
    purchases.products.keys.toSet(),
  );
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    builder: (context) => ListenableBuilder(
      listenable: purchases,
      builder: (context, _) => ListView(
        padding: const EdgeInsets.all(20),
        shrinkWrap: true,
        children: [
          Text(
            context.tr('store', 'Store'),
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
          ),
          if (purchases.busy) ...[
            const LinearProgressIndicator(),
            Text(
              context.tr(
                'purchasePending',
                'Waiting for purchase confirmation…',
              ),
            ),
          ],
          if (purchases.error ||
              response.error != null ||
              response.notFoundIDs.isNotEmpty)
            Text(
              context.tr(
                'purchaseRetry',
                'Purchase confirmation failed. Restore purchases before trying to buy again.',
              ),
              style: const TextStyle(color: Colors.orangeAccent),
            ),
          if (purchases.confirmed)
            Text(context.tr('purchaseConfirmed', 'Purchase confirmed')),
          ...response.productDetails.map(
            (product) => ListTile(
              title: Text(product.title),
              subtitle: Text(product.description),
              trailing: Text(product.price),
              enabled: !purchases.busy,
              onTap: () => purchases.buy(product),
            ),
          ),
          TextButton(
            onPressed: purchases.busy ? null : purchases.restore,
            child: Text(context.tr('restorePurchases', 'Restore purchases')),
          ),
        ],
      ),
    ),
  );
}
