part of 'app.dart';

class _AccountRecordsPage extends StatefulWidget {
  const _AccountRecordsPage({
    required this.controller,
    required this.entitlements,
  });
  final AppController controller;
  final bool entitlements;
  @override
  State<_AccountRecordsPage> createState() => _AccountRecordsPageState();
}

class _AccountRecordsPageState extends State<_AccountRecordsPage> {
  final List<Map<String, dynamic>> records = [];
  String? cursor, balance;
  Object? error;
  bool busy = false;
  String status = 'active';
  late final String scope = widget.controller.accountScope;

  @override
  void initState() {
    super.initState();
    _load(reset: true);
  }

  Future<void> _load({bool reset = false}) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final page = await widget.controller.repository.accountRecords(
        entitlements: widget.entitlements,
        locale: widget.controller.locale,
        cursor: reset ? null : cursor,
        status: status,
      );
      final wallet = widget.entitlements
          ? null
          : await widget.controller.wallet();
      if (!mounted || scope != widget.controller.accountScope) return;
      setState(() {
        if (reset) records.clear();
        records.addAll(
          (page['items'] as List? ?? []).map(
            (item) => Map<String, dynamic>.from(item as Map),
          ),
        );
        cursor = page['nextCursor'] as String?;
        balance = wallet?.balancePoints;
      });
    } catch (cause) {
      if (mounted) setState(() => error = cause);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: Text(
          widget.entitlements
              ? context.tr('membership', 'Membership')
              : context.tr('coins', 'Coins'),
        ),
      ),
      body: scope != widget.controller.accountScope
          ? Center(child: Text(context.tr('signIn', 'Sign in')))
          : RefreshIndicator(
              onRefresh: () => _load(reset: true),
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(20),
                children: [
                  if (!widget.entitlements)
                    Text(
                      balance ?? '…',
                      style: const TextStyle(
                        fontSize: 32,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  FilledButton(
                    onPressed: () async {
                      await _openStoreForController(context, widget.controller);
                      if (mounted) await _load(reset: true);
                    },
                    child: Text(
                      widget.entitlements
                          ? context.tr('plansBenefits', 'Plans and benefits')
                          : context.tr('moreCoins', 'Get more coins'),
                    ),
                  ),
                  if (widget.entitlements)
                    Wrap(
                      spacing: 8,
                      children: [
                        for (final value in ['active', 'expired'])
                          ChoiceChip(
                            label: Text(
                              value == 'active'
                                  ? (context.isChinese ? '有效权益' : 'Active')
                                  : (context.isChinese ? '已过期' : 'Expired'),
                            ),
                            selected: status == value,
                            onSelected: busy
                                ? null
                                : (_) {
                                    status = value;
                                    _load(reset: true);
                                  },
                          ),
                      ],
                    ),
                  const SizedBox(height: 12),
                  if (records.isEmpty && !busy && error == null)
                    Text(context.tr('nothingHere', 'Nothing here yet')),
                  for (final item in records)
                    Card(
                      child: ListTile(
                        title: Text(
                          widget.entitlements
                              ? '${item['title'] ?? item['type']}'
                              : '${item['deltaPoints']} ${context.tr('coins', 'Coins')}',
                        ),
                        subtitle: Text(
                          widget.entitlements
                              ? '${item['type']} · ${item['expiresAt'] == null ? (context.isChinese ? '永久有效' : 'No expiry') : _recordDate(item['expiresAt'])}'
                              : '${item['entryType']} · ${_recordDate(item['createdAt'])}\n${context.tr('coinBalance', 'Balance')}: ${item['balanceAfterPoints']}',
                        ),
                        onTap: () => showDialog<void>(
                          context: context,
                          builder: (_) => AlertDialog(
                            title: Text(
                              context.isChinese ? '记录详情' : 'Record details',
                            ),
                            content: SingleChildScrollView(
                              child: SelectableText(
                                item.entries
                                    .map(
                                      (entry) => '${entry.key}: ${entry.value}',
                                    )
                                    .join('\n'),
                              ),
                            ),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(context),
                                child: Text(context.tr('close', 'Close')),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  if (busy) const Center(child: CircularProgressIndicator()),
                  if (error != null)
                    TextButton(
                      onPressed: () => _load(reset: records.isEmpty),
                      child: Text(friendlyError(context, error!)),
                    ),
                  if (cursor != null && !busy)
                    TextButton(
                      onPressed: _load,
                      child: Text(context.isChinese ? '加载更多' : 'Load more'),
                    ),
                ],
              ),
            ),
    ),
  );
}

String _recordDate(dynamic value) =>
    DateTime.tryParse('$value')?.toLocal().toString().split('.').first ??
    '$value';

Future<void> _messageDetail(
  BuildContext context,
  AppController controller,
  InboxMessage item,
) async {
  final uri = Uri.tryParse(item.deepLink ?? '');
  final dramaId = uri == null
      ? null
      : linkedDramaId(uri, controller.config.deepLinkHost);
  final scope = controller.accountScope;
  final open = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(item.title),
      content: SingleChildScrollView(child: SelectableText(item.body)),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: Text(context.tr('close', 'Close')),
        ),
        if (dramaId != null)
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(context.isChinese ? '查看短剧' : 'Open drama'),
          ),
      ],
    ),
  );
  if (open != true ||
      dramaId == null ||
      !context.mounted ||
      scope != controller.accountScope) {
    return;
  }
  try {
    final drama = await controller.repository.detail(
      Drama(id: dramaId, title: '', summary: '', totalEpisodes: 0),
      controller.locale,
    );
    if (context.mounted && scope == controller.accountScope) {
      await _openDrama(context, controller, drama);
    }
  } catch (cause) {
    if (context.mounted) _message(context, friendlyError(context, cause));
  }
}

Future<void> _openSettings(BuildContext context, AppController controller) =>
    Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => SettingsPage(controller: controller)),
    );

Future<void> _saveSetting(
  BuildContext context,
  Future<void> Function() save,
) async {
  try {
    await save();
  } catch (cause) {
    if (context.mounted) _message(context, friendlyError(context, cause));
  }
}

Future<void> _openHelp(BuildContext context, AppController controller) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (context) => ListView(
      shrinkWrap: true,
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          context.tr('help', 'Help & support'),
          style: Theme.of(context).textTheme.titleLarge,
        ),
        ListTile(
          title: Text(
            context.isChinese
                ? '联系代理商客服 / 我的反馈'
                : 'Contact support / My feedback',
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () async {
            if (controller.session == null &&
                !await _showLogin(context, controller)) {
              return;
            }
            if (!context.mounted) return;
            await showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              useSafeArea: true,
              showDragHandle: true,
              builder: (_) => _FeedbackSheet(controller: controller),
            );
          },
        ),
        ExpansionTile(
          title: Text(
            context.isChinese
                ? '可以使用哪些邮箱注册？'
                : 'Which email addresses can I use?',
          ),
          children: [
            Text(
              context.isChinese ? '支持有效的邮箱地址，不限 QQ。请检查垃圾邮件；验证码有有效期，重复发送有频率限制。' : 'Any valid email address, not only QQ. Check spam. Codes expire and resend requests are rate-limited.',
            ),
          ],
        ),
        ExpansionTile(
          title: Text(
            context.isChinese ? '广告和金币怎样解锁？' : 'How do unlocks work?',
          ),
          children: [
            Text(
              context.isChinese
                  ? '在锁定的剧集选择广告解锁一集或使用金币；以服务器确认的权益为准。广告不可用时可稍后重试。'
                  : 'On a locked episode choose rewarded ad or coins. Access is granted after server confirmation. Retry later if no ad is available.',
            ),
          ],
        ),
        ExpansionTile(
          title: Text(
            context.isChinese
                ? '换手机如何恢复？'
                : 'How do I restore on another device?',
          ),
          children: [
            Text(
              context.isChinese
                  ? '使用同一个 App 账号及商店账号，在会员页面打开商店并选择恢复购买。消耗型金币以服务端余额为准。'
                  : 'Use the same app and store accounts, then open the membership store and restore purchases. Coin balance is held by the server.',
            ),
          ],
        ),
        ListTile(
          title: Text(
            context.isChinese ? '隐私政策与服务协议' : 'Privacy policy and terms',
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => _showLegal(context, controller),
        ),
      ],
    ),
  );
}

class _FeedbackSheet extends StatefulWidget {
  const _FeedbackSheet({required this.controller});
  final AppController controller;
  @override
  State<_FeedbackSheet> createState() => _FeedbackSheetState();
}

class _FeedbackSheetState extends State<_FeedbackSheet> {
  final input = TextEditingController();
  final List<Map<String, dynamic>> items = [];
  late final String scope = widget.controller.accountScope;
  String? lastBody, requestKey;
  bool busy = false, more = false;
  int page = 1;
  Object? error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  Future<void> _load({bool next = false}) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.controller.repository.feedback(
        page: next ? page + 1 : 1,
      );
      if (!mounted || scope != widget.controller.accountScope) return;
      final batch = (result['items'] as List? ?? [])
          .map((item) => Map<String, dynamic>.from(item as Map))
          .toList();
      setState(() {
        if (!next) items.clear();
        items.addAll(batch);
        page = next ? page + 1 : 1;
        more = batch.length == 30;
      });
    } catch (cause) {
      if (mounted) setState(() => error = cause);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _send() async {
    final body = input.text.trim();
    if (body.isEmpty || busy) return;
    if (body != lastBody) {
      lastBody = body;
      requestKey = 'feedback-${DateTime.now().microsecondsSinceEpoch}';
    }
    setState(() {
      busy = true;
      error = null;
    });
    var sent = false;
    try {
      await widget.controller.repository.feedback(
        body: body,
        locale: widget.controller.locale,
        requestKey: requestKey,
      );
      if (!mounted || scope != widget.controller.accountScope) return;
      input.clear();
      lastBody = null;
      requestKey = null;
      sent = true;
      _message(
        context,
        context.isChinese
            ? '已提交给代理商，回复会显示在消息中'
            : 'Sent to your operator. Replies appear in Messages.',
      );
    } catch (cause) {
      if (mounted) setState(() => error = cause);
    } finally {
      if (mounted) setState(() => busy = false);
    }
    if (sent) await _load();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) => SizedBox(
      height: MediaQuery.sizeOf(context).height * .8,
      child: scope != widget.controller.accountScope
          ? Center(child: Text(context.tr('signIn', 'Sign in')))
          : Padding(
              padding: EdgeInsets.fromLTRB(
                20,
                0,
                20,
                MediaQuery.viewInsetsOf(context).bottom,
              ),
              child: Column(
                children: [
                  Text(
                    context.isChinese ? '客服与反馈' : 'Support',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  Expanded(
                    child: RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        children: [
                          if (items.isEmpty && !busy)
                            Text(context.tr('nothingHere', 'Nothing here yet')),
                          for (final item in items)
                            Card(
                              child: Padding(
                                padding: const EdgeInsets.all(12),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    SelectableText('${item['body']}'),
                                    Text(
                                      _recordDate(item['createdAt']),
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall,
                                    ),
                                    const Divider(),
                                    Text(
                                      item['reply'] as String? ??
                                          (context.isChinese
                                              ? '等待代理商回复'
                                              : 'Awaiting a reply'),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          if (more)
                            TextButton(
                              onPressed: busy ? null : () => _load(next: true),
                              child: Text(
                                context.isChinese ? '加载更多' : 'Load more',
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  if (error != null)
                    TextButton(
                      onPressed: _load,
                      child: Text(friendlyError(context, error!)),
                    ),
                  TextField(
                    controller: input,
                    minLines: 2,
                    maxLines: 3,
                    maxLength: 2000,
                    decoration: InputDecoration(
                      hintText: context.isChinese ? '请描述遇到的问题，不要提供密码或验证码' : 'Describe the issue. Never include passwords or verification codes.',
                    ),
                  ),
                  FilledButton(
                    onPressed: busy ? null : _send,
                    child: Text(busy ? '…' : context.tr('send', 'Send')),
                  ),
                  const SizedBox(height: 12),
                ],
              ),
            ),
    ),
  );
}
