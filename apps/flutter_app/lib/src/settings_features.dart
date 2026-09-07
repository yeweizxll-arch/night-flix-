part of 'app.dart';

const _settingsChannel = MethodChannel('nightflix/settings');

Future<void> _showLegal(BuildContext context, AppController controller) =>
    Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => _SettingsLegalPage(controller: controller),
      ),
    );

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => _SettingsFrame(
      title: context.tr('settings', 'Settings'),
      child: Builder(
        builder: (context) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _settingsHeading(context.isChinese ? '播放' : 'Playback'),
            Card(
              child: Column(
                children: [
                  SwitchListTile(
                    title: Text(
                      context.isChinese ? '自动播放下一集' : 'Autoplay next episode',
                    ),
                    value: controller.autoAdvance,
                    onChanged: (v) => _saveSetting(
                      context,
                      () => controller.setPlaybackSettings(autoAdvance: v),
                    ),
                  ),
                  SwitchListTile(
                    title: Text(
                      context.isChinese
                          ? '默认显示字幕'
                          : 'Show subtitles by default',
                    ),
                    value: controller.subtitlesEnabled,
                    onChanged: (v) => _saveSetting(
                      context,
                      () => controller.setPlaybackSettings(subtitlesEnabled: v),
                    ),
                  ),
                  ListTile(
                    title: Text(context.tr('playbackSpeed', 'Playback speed')),
                    trailing: DropdownButton<double>(
                      value: controller.playbackSpeed,
                      items: playbackSpeeds
                          .map(
                            (v) =>
                                DropdownMenuItem(value: v, child: Text('$v×')),
                          )
                          .toList(),
                      onChanged: (v) {
                        if (v != null) {
                          _saveSetting(
                            context,
                            () => controller.setPlaybackSettings(speed: v),
                          );
                        }
                      },
                    ),
                  ),
                ],
              ),
            ),
            _settingsHeading(context.isChinese ? '通用' : 'General'),
            Card(
              child: Column(
                children: [
                  _settingsLink(
                    context.tr('language', 'Language'),
                    () => _languageSheet(context, controller),
                    subtitle:
                        localeNames[controller.locale] ?? controller.locale,
                  ),
                  _settingsLink(
                    context.isChinese ? '通知偏好' : 'Notification preferences',
                    () => _openAccountSetting(
                      context,
                      controller,
                      'notifications',
                    ),
                  ),
                  _settingsLink(
                    context.isChinese ? '清除图片缓存' : 'Clear image cache',
                    () async {
                      final ok = await _confirmSetting(
                        context,
                        context.isChinese ? '清除图片缓存？' : 'Clear image cache?',
                        context.isChinese
                            ? '只释放内存中的图片缓存，不删除登录、收藏、历史或购买记录。封面会按需重新加载。'
                            : 'Only cached images in memory are cleared. Your login, favorites, history and purchases are kept. Covers will reload as needed.',
                      );
                      if (!ok || !context.mounted) return;
                      PaintingBinding.instance.imageCache.clear();
                      controller.clearImageUrls();
                      _message(
                        context,
                        context.isChinese ? '图片缓存已清除' : 'Image cache cleared',
                      );
                    },
                  ),
                ],
              ),
            ),
            _settingsHeading(context.isChinese ? '账号与隐私' : 'Account & privacy'),
            Card(
              child: Column(
                children: [
                  if (controller.session != null)
                    ListTile(
                      title: Text(context.tr('email', 'Email')),
                      subtitle: SelectableText(controller.session!.email),
                    ),
                  _settingsLink(
                    context.isChinese ? '修改密码' : 'Change password',
                    () => _openAccountSetting(context, controller, 'password'),
                  ),
                  _settingsLink(
                    context.isChinese ? '登录设备管理' : 'Signed-in devices',
                    () => _openAccountSetting(context, controller, 'devices'),
                  ),
                  _settingsLink(
                    context.isChinese ? '导出个人数据' : 'Export personal data',
                    () => _openAccountSetting(context, controller, 'export'),
                  ),
                  _settingsLink(
                    context.isChinese ? '注销账号' : 'Delete account',
                    () => _openAccountSetting(context, controller, 'erasure'),
                  ),
                  ListenableBuilder(
                    listenable: adsFor(controller),
                    builder: (context, _) => adsFor(controller).privacyRequired
                        ? _settingsLink(
                            context.tr('adPrivacy', 'Ad privacy choices'),
                            () => _saveSetting(
                              context,
                              () => adsFor(controller).privacyOptions(),
                            ),
                          )
                        : const SizedBox.shrink(),
                  ),
                ],
              ),
            ),
            _settingsHeading(context.isChinese ? '支持与关于' : 'Support & about'),
            Card(
              child: Column(
                children: [
                  _settingsLink(
                    context.tr('help', 'Help & support'),
                    () => _openHelp(context, controller),
                  ),
                  _settingsLink(
                    context.isChinese
                        ? '隐私政策与服务协议'
                        : 'Privacy policy and terms',
                    () => Navigator.push<void>(
                      context,
                      MaterialPageRoute(
                        builder: (_) =>
                            _SettingsLegalPage(controller: controller),
                      ),
                    ),
                  ),
                  _settingsLink(
                    context.isChinese ? '关于应用' : 'About this app',
                    () => Navigator.push<void>(
                      context,
                      MaterialPageRoute(
                        builder: (_) =>
                            _SettingsAboutPage(controller: controller),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (controller.session != null)
              OutlinedButton(
                onPressed: () => _confirmSignOut(context, controller),
                child: Text(context.tr('signOut', 'Sign out')),
              ),
          ],
        ),
      ),
    ),
  );
}

Widget _settingsHeading(String title) => Padding(
  padding: const EdgeInsets.fromLTRB(8, 12, 8, 10),
  child: Text(
    title,
    style: const TextStyle(fontWeight: FontWeight.w600, color: Colors.black54),
  ),
);

Widget _settingsLink(String title, VoidCallback onTap, {String? subtitle}) =>
    ListTile(
      title: Text(title),
      subtitle: subtitle == null ? null : Text(subtitle),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );

class _SettingsFrame extends StatelessWidget {
  const _SettingsFrame({required this.title, required this.child});
  final String title;
  final Widget child;
  @override
  Widget build(BuildContext context) => Theme(
    data: _lightPageTheme(context),
    child: Builder(
      builder: (context) => Scaffold(
        appBar: AppBar(title: Text(title)),
        body: SafeArea(top: false, child: child),
      ),
    ),
  );
}

Future<bool> _confirmSetting(
  BuildContext context,
  String title,
  String message,
) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => Theme(
        data: _lightPageTheme(context),
        child: AlertDialog(
          title: Text(title),
          content: Text(message),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(context.isChinese ? '取消' : 'Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(context.isChinese ? '确认' : 'Confirm'),
            ),
          ],
        ),
      ),
    ) ==
    true;

Future<void> _confirmSignOut(
  BuildContext context,
  AppController controller,
) async {
  final scope = controller.accountScope;
  if (!await _confirmSetting(
    context,
    context.tr('signOut', 'Sign out'),
    context.isChinese ? '退出后可继续浏览，购买与收藏需要重新登录。' : 'You can keep browsing. Purchases and favorites require signing in again.',
  )) {
    return;
  }
  if (context.mounted && controller.accountScope == scope) {
    try {
      await controller.logout();
    } catch (cause) {
      if (context.mounted) {
        _message(
          context,
          controller.session == null
              ? (context.isChinese
                    ? '本机已退出，但暂时无法确认服务器会话已撤销。'
                    : 'Signed out on this device, but server session revocation could not be confirmed.')
              : friendlyError(context, cause),
        );
      }
    }
  }
}

Future<void> _openAccountSetting(
  BuildContext context,
  AppController controller,
  String kind,
) async {
  if (controller.session == null && !await _showLogin(context, controller)) {
    return;
  }
  if (!context.mounted) return;
  final scope = controller.accountScope;
  await Navigator.push<void>(
    context,
    MaterialPageRoute(
      builder: (_) => ListenableBuilder(
        listenable: controller,
        builder: (context, _) =>
            controller.session == null || scope != controller.accountScope
            ? _SettingsFrame(
                title: context.tr('settings', 'Settings'),
                child: Center(
                  child: Text(
                    context.isChinese
                        ? '账号状态已变化，请返回设置。'
                        : 'Account changed. Please return to Settings.',
                  ),
                ),
              )
            : switch (kind) {
                'notifications' => _NotificationSettingsPage(
                  controller: controller,
                ),
                'devices' => _DevicesSettingsPage(controller: controller),
                _ => _AccountSettingsForm(controller: controller, kind: kind),
              },
      ),
    ),
  );
}

class _NotificationSettingsPage extends StatefulWidget {
  const _NotificationSettingsPage({required this.controller});
  final AppController controller;
  @override
  State<_NotificationSettingsPage> createState() =>
      _NotificationSettingsPageState();
}

class _NotificationSettingsPageState extends State<_NotificationSettingsPage>
    with WidgetsBindingObserver {
  Map<String, dynamic>? preferences;
  bool? allowed;
  bool busy = false;
  Object? error;
  String? permissionError;
  late final String scope = widget.controller.accountScope;
  bool get active =>
      mounted &&
      scope == widget.controller.accountScope &&
      widget.controller.session != null;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
    _permission();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _permission();
  }

  Future<void> _permission() async {
    try {
      final value = await _settingsChannel.invokeMethod<bool>(
        'notificationsAllowed',
      );
      if (active) {
        setState(() {
          allowed = value;
          permissionError = null;
        });
      }
    } catch (_) {
      if (active) setState(() => permissionError = 'unavailable');
    }
  }

  Future<void> _load([Map<String, dynamic>? update]) async {
    if (!active || busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.controller.repository.notificationPreferences(
        update: update,
      );
      if (active) setState(() => preferences = result);
    } catch (cause) {
      if (active) setState(() => error = cause);
    } finally {
      if (active) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => _SettingsFrame(
    title: context.isChinese ? '通知偏好' : 'Notification preferences',
    child: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (busy) const LinearProgressIndicator(),
        if (error != null) _settingsError(context, error!, () => _load()),
        if (preferences != null)
          for (final key in ['marketingInAppEnabled', 'marketingPushEnabled'])
            SwitchListTile(
              title: Text(
                key == 'marketingInAppEnabled'
                    ? (context.isChinese ? '站内运营消息' : 'In-app promotions')
                    : (context.isChinese ? '运营推送' : 'Push promotions'),
              ),
              value: preferences![key] == true,
              onChanged: busy ? null : (value) => _load({key: value}),
            ),
        const SizedBox(height: 12),
        Text(
          context.isChinese ? '订单和安全通知仍会保留。接收推送还需要系统授权。' : 'Order and security messages stay enabled. Push also requires device permission.',
        ),
        ListTile(
          title: Text(
            context.isChinese ? '系统通知权限' : 'System notification permission',
          ),
          subtitle: Text(
            permissionError != null || allowed == null
                ? (context.isChinese
                      ? '未能读取权限状态'
                      : 'Permission status unavailable')
                : allowed!
                ? (context.isChinese ? '已允许' : 'Allowed')
                : (context.isChinese ? '未允许' : 'Not allowed'),
          ),
        ),
        OutlinedButton(
          onPressed: () => _saveSetting(context, () async {
            final opened = await _settingsChannel.invokeMethod<bool>(
              'openAppSettings',
            );
            if (opened != true) {
              throw StateError('Could not open system settings');
            }
          }),
          child: Text(context.isChinese ? '打开系统设置' : 'Open system settings'),
        ),
      ],
    ),
  );
}

Widget _settingsError(BuildContext context, Object error, VoidCallback retry) =>
    Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        children: [
          Text(friendlyError(context, error)),
          TextButton(
            onPressed: retry,
            child: Text(context.tr('retry', 'Retry')),
          ),
        ],
      ),
    );

class _DevicesSettingsPage extends StatefulWidget {
  const _DevicesSettingsPage({required this.controller});
  final AppController controller;
  @override
  State<_DevicesSettingsPage> createState() => _DevicesSettingsPageState();
}

class _DevicesSettingsPageState extends State<_DevicesSettingsPage> {
  List<Map<String, dynamic>> devices = [];
  Object? error;
  bool busy = false;
  final keys = <String, String>{};
  late final String scope = widget.controller.accountScope;
  bool get active =>
      mounted &&
      scope == widget.controller.accountScope &&
      widget.controller.session != null;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (!active || busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.controller.repository.accountDevices();
      if (active) setState(() => devices = result);
    } catch (cause) {
      if (active) setState(() => error = cause);
    } finally {
      if (active) setState(() => busy = false);
    }
  }

  Future<void> _revoke(Map<String, dynamic> device) async {
    if (!active || busy) return;
    final current = device['current'] == true;
    final label = device['label'] ?? device['platform'] ?? 'Device';
    if (!await _confirmSetting(
      context,
      context.isChinese ? '退出“$label”？' : 'Sign out “$label”?',
      current
          ? (context.isChinese
                ? '这是当前设备。确认后本应用也会退出登录。'
                : 'This is your current device. Confirming also signs you out here.')
          : (context.isChinese
                ? '该设备需要重新登录，本机仍保持登录。'
                : 'That device will need to sign in again. You will stay signed in on this device.'),
    )) {
      return;
    }
    if (!active || busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final id = device['id'] as String;
      await widget.controller.repository.revokeDevice(
        id,
        keys.putIfAbsent(
          id,
          () => 'device-${DateTime.now().microsecondsSinceEpoch}',
        ),
      );
      if (!active) return;
      setState(() {
        devices.removeWhere((v) => v['id'] == id);
        keys.remove(id);
      });
    } catch (cause) {
      if (active) setState(() => error = cause);
    } finally {
      if (active) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => _SettingsFrame(
    title: context.isChinese ? '登录设备管理' : 'Signed-in devices',
    child: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (busy) const LinearProgressIndicator(),
        if (error != null) _settingsError(context, error!, _load),
        if (!busy && error == null && devices.isEmpty)
          Text(context.tr('nothingHere', 'Nothing here yet')),
        for (final device in devices)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${device['label'] ?? device['platform'] ?? 'Device'}',
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  ),
                  if (device['current'] == true)
                    Text(context.isChinese ? '当前设备' : 'This device'),
                  Text(
                    '${context.isChinese ? '最近活跃' : 'Last active'}: ${_recordDate(device['lastSeenAt'])}',
                  ),
                  OutlinedButton(
                    onPressed: busy ? null : () => _revoke(device),
                    child: Text(context.tr('signOut', 'Sign out')),
                  ),
                ],
              ),
            ),
          ),
      ],
    ),
  );
}

const _exportSections = {
  'profile': ['账号资料', 'Profile'],
  'consents': ['协议同意记录', 'Consent records'],
  'orders': ['订单', 'Orders'],
  'comments': ['评论', 'Comments'],
  'bulletComments': ['弹幕记录', 'Bullet comments'],
  'watchProgress': ['观看记录', 'Watch history'],
  'favorites': ['收藏', 'Favorites'],
  'following': ['追剧', 'Following'],
  'feedback': ['反馈', 'Feedback'],
  'notifications': ['消息', 'Messages'],
};

class _AccountSettingsForm extends StatefulWidget {
  const _AccountSettingsForm({required this.controller, required this.kind});
  final AppController controller;
  final String kind;
  @override
  State<_AccountSettingsForm> createState() => _AccountSettingsFormState();
}

class _AccountSettingsFormState extends State<_AccountSettingsForm> {
  final password = TextEditingController();
  final next = TextEditingController();
  final confirm = TextEditingController();
  final form = GlobalKey<FormState>();
  final requestKey = 'erasure-${DateTime.now().microsecondsSinceEpoch}';
  String section = 'profile';
  bool acknowledged = false;
  bool busy = false;
  String? error;
  String? success;
  Map<String, dynamic>? exported;
  late final String scope;
  @override
  void initState() {
    super.initState();
    scope = widget.controller.accountScope;
  }

  bool get active =>
      mounted &&
      widget.controller.session != null &&
      scope == widget.controller.accountScope;
  @override
  void dispose() {
    password.dispose();
    next.dispose();
    confirm.dispose();
    super.dispose();
  }

  Future<void> _submit({bool nextPage = false}) async {
    if (!active || busy || !form.currentState!.validate()) return;
    if (widget.kind == 'erasure') {
      if (!acknowledged) return;
      if (!await _confirmSetting(
        context,
        context.isChinese ? '确认申请注销？' : 'Request account deletion?',
        context.isChinese ? '提交后立即停用账号，不能继续播放已购内容。此操作不是退出登录。' : 'Submitting immediately disables your account and access to purchases. This is not just signing out.',
      )) {
        return;
      }
      if (!active || busy) return;
    }
    setState(() {
      busy = true;
      error = null;
      success = null;
    });
    try {
      final repository = widget.controller.repository;
      if (widget.kind == 'password') {
        await repository.changePassword(password.text, next.text);
        if (active) {
          setState(() {
            success = context.isChinese
                ? '密码已修改，其他登录会话已退出。'
                : 'Password changed. Other sessions have been signed out.';
            password.clear();
            next.clear();
            confirm.clear();
          });
        }
      } else if (widget.kind == 'export') {
        final result = await repository.exportAccountData(
          password: password.text,
          section: section,
          cursor: nextPage ? (exported?['nextCursor'] as String?) : null,
        );
        if (active) setState(() => exported = result);
      } else {
        // Capture the messenger before the successful request disposes this account-scoped form.
        if (!mounted || !active) return;
        final messenger = ScaffoldMessenger.of(context);
        final message = context.isChinese
            ? '注销申请已提交。账号已停用，数据将按隐私政策处理，并非立即全部删除。'
            : 'Deletion requested. Your account is disabled. Data will be processed under the privacy policy, not erased immediately.';
        await repository.requestAccountErasure(password.text, requestKey);
        if (messenger.mounted && widget.controller.session == null) {
          messenger.showSnackBar(SnackBar(content: Text(message)));
        }
      }
    } catch (cause) {
      if (active) {
        setState(
          () => error = cause is ApiException && cause.statusCode == 401
              ? (context.isChinese
                    ? '当前密码不正确或登录已过期，请核对密码或重新登录。'
                    : 'Current password is incorrect or your session has expired. Check your password or sign in again.')
              : widget.controller.repository.demoMode
              ? (context.isChinese
                    ? '演示模式不修改账号，请连接测试服务器。'
                    : 'Account management requires a connected server, not demo mode.')
              : friendlyError(context, cause),
        );
      }
    } finally {
      if (active) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = switch (widget.kind) {
      'password' => context.isChinese ? '修改密码' : 'Change password',
      'export' => context.isChinese ? '导出个人数据' : 'Export personal data',
      _ => context.isChinese ? '注销账号' : 'Delete account',
    };
    return _SettingsFrame(
      title: title,
      child: Form(
        key: form,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (widget.kind == 'erasure') ...[
              Text(
                context.isChinese
                    ? '注销会停用本代理商下的账号并撤销登录。购买权益将无法使用；订单、结算及安全记录等可能依法保留。外部服务的数据删除另行处理。商店订阅需前往 Apple 或 Google 商店取消，注销不会自动取消续费。'
                    : 'Deletion disables your account with this operator and revokes sign-ins. Purchases become inaccessible. Order, settlement and security records may be retained as required; external services are handled separately. Cancel subscriptions in the Apple or Google store: deleting your account does not cancel renewals.',
              ),
              const SizedBox(height: 16),
            ],
            if (widget.kind == 'export') ...[
              Text(
                context.isChinese ? '按类别分页读取真实记录。保存/分享仅包含当前页，不包含密码或登录令牌。' : 'Read real records by category and page. Save/share exports the current page only, without passwords or login tokens.',
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: section,
                decoration: InputDecoration(
                  labelText: context.isChinese ? '数据类别' : 'Data category',
                ),
                items: _exportSections.entries
                    .map(
                      (e) => DropdownMenuItem(
                        value: e.key,
                        child: Text(e.value[context.isChinese ? 0 : 1]),
                      ),
                    )
                    .toList(),
                onChanged: busy
                    ? null
                    : (v) {
                        if (v != null) {
                          setState(() {
                            section = v;
                            exported = null;
                            error = null;
                          });
                        }
                      },
              ),
              const SizedBox(height: 16),
            ],
            TextFormField(
              controller: password,
              enabled: !busy,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                labelText: context.isChinese ? '当前密码' : 'Current password',
              ),
              validator: (v) => (v ?? '').isEmpty
                  ? (context.isChinese
                        ? '请输入当前密码'
                        : 'Enter your current password')
                  : null,
            ),
            if (widget.kind == 'password') ...[
              const SizedBox(height: 16),
              TextFormField(
                controller: next,
                enabled: !busy,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                decoration: InputDecoration(
                  labelText: context.isChinese ? '新密码' : 'New password',
                ),
                validator: (v) {
                  final bytes = utf8.encode(v ?? '').length;
                  if (bytes < 8 || bytes > 4096) {
                    return context.isChinese
                        ? '密码需为 8–4096 个 UTF-8 字节'
                        : 'Use 8–4096 UTF-8 bytes';
                  }
                  if (v == password.text) {
                    return context.isChinese
                        ? '请使用不同的新密码'
                        : 'Choose a different password';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: confirm,
                enabled: !busy,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                decoration: InputDecoration(
                  labelText: context.isChinese
                      ? '确认新密码'
                      : 'Confirm new password',
                ),
                validator: (v) => v != next.text
                    ? (context.isChinese ? '两次密码不一致' : 'Passwords do not match')
                    : null,
              ),
            ],
            TextButton(
              onPressed: busy
                  ? null
                  : () => showAccountSheet(
                      context,
                      widget.controller,
                      resetPassword: true,
                    ),
              child: Text(
                context.isChinese
                    ? '忘记密码 / 用邮箱设置密码'
                    : 'Forgot password / Set a password by email',
              ),
            ),
            if (widget.kind == 'erasure')
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  context.isChinese ? '我已了解停用、权益、数据保留和订阅规则' : 'I understand account access, retention and subscription rules',
                ),
                value: acknowledged,
                onChanged: busy
                    ? null
                    : (v) => setState(() => acknowledged = v == true),
              ),
            if (error != null)
              Text(
                error!,
                style: TextStyle(
                  color: _lightPageTheme(context).colorScheme.error,
                ),
              ),
            if (success != null) Text(success!),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: busy || (widget.kind == 'erasure' && !acknowledged)
                  ? null
                  : () => _submit(),
              child: Text(
                busy ? (context.isChinese ? '处理中…' : 'Processing…') : title,
              ),
            ),
            if (exported != null) ...[
              const SizedBox(height: 16),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 280),
                child: SingleChildScrollView(
                  key: const ValueKey('settings-export-preview'),
                  primary: false,
                  child: SelectableText(
                    const JsonEncoder.withIndent('  ').convert(exported),
                  ),
                ),
              ),
              if (exported!['nextCursor'] != null)
                OutlinedButton(
                  onPressed: busy ? null : () => _submit(nextPage: true),
                  child: Text(context.isChinese ? '读取下一页' : 'Read next page'),
                ),
              OutlinedButton(
                onPressed: busy
                    ? null
                    : () => _saveSetting(context, () async {
                        if (!active) return;
                        final data = utf8.encode(
                          const JsonEncoder.withIndent('  ').convert(exported),
                        );
                        await SharePlus.instance.share(
                          ShareParams(
                            files: [
                              XFile.fromData(
                                data,
                                mimeType: 'application/json',
                              ),
                            ],
                            fileNameOverrides: ['nightflix-$section.json'],
                            sharePositionOrigin: Rect.fromLTWH(
                              0,
                              0,
                              MediaQuery.sizeOf(context).width,
                              100,
                            ),
                          ),
                        );
                      }),
                child: Text(
                  context.isChinese
                      ? '保存 / 分享当前页'
                      : 'Save / share current page',
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SettingsLegalPage extends StatefulWidget {
  const _SettingsLegalPage({required this.controller});
  final AppController controller;
  @override
  State<_SettingsLegalPage> createState() => _SettingsLegalPageState();
}

class _SettingsLegalPageState extends State<_SettingsLegalPage> {
  late Future<List<Map<String, dynamic>>> documents = widget
      .controller
      .repository
      .legalDocuments(widget.controller.locale);
  @override
  Widget build(BuildContext context) => _SettingsFrame(
    title: context.isChinese ? '隐私政策与服务协议' : 'Privacy policy and terms',
    child: FutureBuilder(
      future: documents,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return _settingsError(
            context,
            snapshot.error!,
            () => setState(() {
              documents = widget.controller.repository.legalDocuments(
                widget.controller.locale,
              );
            }),
          );
        }
        if (snapshot.data!.isEmpty) {
          return Center(
            child: Text(
              context.isChinese
                  ? '代理商尚未配置协议，请联系客服。'
                  : 'No policies configured. Please contact support.',
            ),
          );
        }
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final doc in snapshot.data!)
              Card(
                child: ExpansionTile(
                  title: Text('${doc['title'] ?? doc['documentType']}'),
                  subtitle: Text(
                    '${context.isChinese ? '版本' : 'Version'} ${doc['version'] ?? '—'}',
                  ),
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: SelectableText('${doc['bodyMarkdown'] ?? ''}'),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    ),
  );
}

class _SettingsAboutPage extends StatefulWidget {
  const _SettingsAboutPage({required this.controller});
  final AppController controller;
  @override
  State<_SettingsAboutPage> createState() => _SettingsAboutPageState();
}

class _SettingsAboutPageState extends State<_SettingsAboutPage> {
  late Future<Map<String, dynamic>?> info = _settingsChannel
      .invokeMapMethod<String, dynamic>('appInfo');
  @override
  Widget build(BuildContext context) => _SettingsFrame(
    title: context.isChinese ? '关于应用' : 'About this app',
    child: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          widget.controller.config.siteName,
          style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 16),
        FutureBuilder(
          future: info,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const LinearProgressIndicator();
            }
            if (snapshot.hasError || snapshot.data == null) {
              return _settingsError(
                context,
                snapshot.error ?? StateError('Version unavailable'),
                () => setState(() {
                  info = _settingsChannel.invokeMapMethod<String, dynamic>(
                    'appInfo',
                  );
                }),
              );
            }
            return SelectableText(
              '${context.isChinese ? '版本' : 'Version'}: ${snapshot.data!['version']} (${snapshot.data!['build']})\n${snapshot.data!['package']}',
            );
          },
        ),
        const SizedBox(height: 16),
        Text(
          context.isChinese ? '正式版通过应用商店更新；测试版需安装新的测试包。远程配置不会更新应用代码。' : 'Production updates come from the app store; test versions require a new installer. Remote configuration does not update app code.',
        ),
      ],
    ),
  );
}
