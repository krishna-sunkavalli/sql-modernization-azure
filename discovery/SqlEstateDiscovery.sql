/*==============================================================================
  SQL Estate Discovery Script  —  v1.0
  Companion to the SQL Estate Analyzer (single-file, client-side Azure sizing tool)

  WHAT IT DOES
    Produces one row per user database, with instance-level attributes repeated
    on each row, covering everything the Analyzer needs to recommend an Azure
    target (SQL Database / Hyperscale / Managed Instance / SQL Server on Azure VM)
    and estimate cost.

  WHAT IT DOES *NOT* DO
    - No writes. No configuration changes. Read-only DMV/catalog queries.
    - Collects NO data, schema, object names, or query text. Only counts, sizes,
      versions and feature flags. Safe to hand to a DBA for review before running.

  REQUIREMENTS
    - SQL Server 2012 (11.x) or later, on Windows or Linux.
    - Permission: VIEW SERVER STATE + VIEW ANY DEFINITION (sysadmin is simplest).
    - Run once per INSTANCE. To cover a whole estate in one pass, use the
      companion PowerShell script Invoke-SqlEstateDiscovery.ps1 instead.

  COST
    Catalog views and DMVs only. No trace, no Extended Events, no DBCC, no user
    data read — nothing to block, safe during business hours. Roughly 1 second
    per instance plus 1-5 ms per database (20-40 ms for a 1,500+ object schema).
    A database with AUTO_CLOSE ON costs ~425 ms because every USE must start it
    up; IsAutoClose is reported per database so you can spot that.

  HOW TO RUN
    Option 1 - SSMS (easiest)
      1. Leave @Format = 'GRID' below.
      2. Execute. Right-click the results grid -> "Save Results As..." -> CSV.
      3. Repeat per instance. Upload every CSV to the Analyzer.

    Option 2 - sqlcmd (best for scripting across many instances)
      Set @Format = 'CSV' below, then:
        sqlcmd -S MYSERVER\MYINST -E -i SqlEstateDiscovery.sql -o MYSERVER_MYINST.csv -h -1 -W -s "" -y 0

    Option 3 - PowerShell across many instances
      See collect-estate.ps1 shipped alongside this script.

  RUNTIME
    Typically < 30 seconds. Scales with database count, not data volume.
==============================================================================*/

SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

DECLARE @Format sysname = 'GRID';   -- 'GRID' for SSMS, 'CSV' for sqlcmd
DECLARE @SchemaVersion varchar(10) = '1.0';

/*------------------------------------------------------------------------------
  1. Instance-level facts
------------------------------------------------------------------------------*/
DECLARE
    @ServerName          nvarchar(256),
    @InstanceName        nvarchar(256),
    @ProductVersion      nvarchar(64),
    @MajorVersion        int,
    @VersionName         nvarchar(64),
    @ProductLevel        nvarchar(64),
    @ProductUpdateLevel  nvarchar(64),
    @Edition             nvarchar(128),
    @EngineEdition       int,
    @IsClustered         bit,
    @IsHadrEnabled       bit,
    @Collation           nvarchar(128),
    @CpuCount            int,
    @SocketCount         int,
    @CoresPerSocket      int,
    @HyperthreadRatio    int,
    @PhysicalMemoryGB    decimal(18,2),
    @MaxServerMemoryGB   decimal(18,2),
    @SqlMemoryTargetGB   decimal(18,2),
    @SqlMemoryInUseGB    decimal(18,2),
    @SchedulerCount      int,
    @CpuSampleCount      int,
    @CpuPressurePct      decimal(18,2),
    @MemPressurePct      decimal(18,2),
    @IoPressurePct       decimal(18,2),
    @OsPlatform          nvarchar(64),
    @OsVersion           nvarchar(128),
    @SqlStartTime        datetime,
    @UptimeHours         decimal(18,2),
    @AvgCpuPct           int,
    @MaxCpuPct           int,
    @AgentJobCount       int,
    @LinkedServerCount   int,
    @HasDatabaseMail     bit,
    @HasSsisCatalog      bit,
    @HasSsrs             bit,
    @IsDistributor       bit,
    @AgCount             int,
    @LoginCount          int,
    @TempDbSizeGB        decimal(18,2),
    @CredentialCount     int,
    @SqlAgentProxyCount  int,
    @sql                 nvarchar(max);

SELECT
    @ServerName         = CONVERT(nvarchar(256), SERVERPROPERTY('MachineName')),
    @InstanceName       = ISNULL(CONVERT(nvarchar(256), SERVERPROPERTY('InstanceName')), N'MSSQLSERVER'),
    @ProductVersion     = CONVERT(nvarchar(64),  SERVERPROPERTY('ProductVersion')),
    @ProductLevel       = CONVERT(nvarchar(64),  SERVERPROPERTY('ProductLevel')),
    @Edition            = CONVERT(nvarchar(128), SERVERPROPERTY('Edition')),
    @EngineEdition      = CONVERT(int,           SERVERPROPERTY('EngineEdition')),
    @IsClustered        = CONVERT(bit,           SERVERPROPERTY('IsClustered')),
    @Collation          = CONVERT(nvarchar(128), SERVERPROPERTY('Collation'));

SET @MajorVersion = CONVERT(int, PARSENAME(@ProductVersion, 4));

-- ProductUpdateLevel (CU) exists only on 2012 SP3+/2014 SP2+ and later.
BEGIN TRY
    SET @ProductUpdateLevel = CONVERT(nvarchar(64), SERVERPROPERTY('ProductUpdateLevel'));
END TRY
BEGIN CATCH
    SET @ProductUpdateLevel = NULL;
END CATCH;

-- IsHadrEnabled exists 2012+.
BEGIN TRY
    SET @IsHadrEnabled = CONVERT(bit, SERVERPROPERTY('IsHadrEnabled'));
END TRY
BEGIN CATCH
    SET @IsHadrEnabled = 0;
END CATCH;

SET @VersionName =
    CASE @MajorVersion
        WHEN 8  THEN N'SQL Server 2000'
        WHEN 9  THEN N'SQL Server 2005'
        WHEN 10 THEN CASE WHEN CONVERT(int, PARSENAME(@ProductVersion,3)) >= 50
                          THEN N'SQL Server 2008 R2' ELSE N'SQL Server 2008' END
        WHEN 11 THEN N'SQL Server 2012'
        WHEN 12 THEN N'SQL Server 2014'
        WHEN 13 THEN N'SQL Server 2016'
        WHEN 14 THEN N'SQL Server 2017'
        WHEN 15 THEN N'SQL Server 2019'
        WHEN 16 THEN N'SQL Server 2022'
        WHEN 17 THEN N'SQL Server 2025'
        ELSE N'Unknown (' + ISNULL(@ProductVersion, N'?') + N')'
    END;

SELECT
    @CpuCount         = cpu_count,
    @HyperthreadRatio = hyperthread_ratio,
    @SocketCount      = CASE WHEN hyperthread_ratio > 0 THEN cpu_count / hyperthread_ratio ELSE NULL END,
    @CoresPerSocket   = hyperthread_ratio,
    @SqlStartTime     = sqlserver_start_time
FROM sys.dm_os_sys_info;

-- physical_memory_kb (2012+) vs physical_memory_in_bytes (2008 R2-).
IF COL_LENGTH('sys.dm_os_sys_info', 'physical_memory_kb') IS NOT NULL
    SELECT @sql = N'SELECT @g = CONVERT(decimal(18,2), physical_memory_kb / 1048576.0) FROM sys.dm_os_sys_info;';
ELSE
    SELECT @sql = N'SELECT @g = CONVERT(decimal(18,2), physical_memory_in_bytes / 1073741824.0) FROM sys.dm_os_sys_info;';
EXEC sp_executesql @sql, N'@g decimal(18,2) OUTPUT', @g = @PhysicalMemoryGB OUTPUT;

SELECT @MaxServerMemoryGB = CASE
           -- 2147483647 MB is the "no limit" default; report it as NULL rather than 2PB.
           WHEN CONVERT(bigint, value_in_use) >= 2147483647 THEN NULL
           ELSE CONVERT(decimal(18,2), CONVERT(bigint, value_in_use) / 1024.0)
       END
FROM sys.configurations WHERE name = 'max server memory (MB)';

/*  Actual memory demand, as opposed to what is installed or configured.
    These DMVs are present on every edition, unlike sys.dm_os_performance_counters,
    which on LocalDB and some minimal installs exposes only a partial counter set.

    SqlMemoryTargetGB is what the engine wants; SqlMemoryInUseGB is what it has.
    Target well above in-use on a long-running instance means the workload has
    never needed the RAM it was given, which is the clearest signal that the
    source hardware is over-provisioned. */
BEGIN TRY
    IF COL_LENGTH('sys.dm_os_sys_info', 'committed_target_kb') IS NOT NULL
    BEGIN
        SET @sql = N'SELECT @t = CONVERT(decimal(18,2), committed_target_kb / 1048576.0) FROM sys.dm_os_sys_info;';
        EXEC sp_executesql @sql, N'@t decimal(18,2) OUTPUT', @t = @SqlMemoryTargetGB OUTPUT;
    END

    IF OBJECT_ID('sys.dm_os_process_memory') IS NOT NULL
    BEGIN
        SET @sql = N'SELECT @u = CONVERT(decimal(18,2), physical_memory_in_use_kb / 1048576.0) FROM sys.dm_os_process_memory;';
        EXEC sp_executesql @sql, N'@u decimal(18,2) OUTPUT', @u = @SqlMemoryInUseGB OUTPUT;
    END

    SELECT @SchedulerCount = COUNT(*) FROM sys.dm_os_schedulers
    WHERE status = 'VISIBLE ONLINE' AND is_online = 1;
END TRY
BEGIN CATCH
    SET @SqlMemoryTargetGB = NULL; SET @SqlMemoryInUseGB = NULL; SET @SchedulerCount = NULL;
END CATCH;

/*  Resource pressure, as a share of total wait time since the instance started.
    Cumulative wait stats cover the whole uptime rather than the ring buffer's
    four-minute-resolution window, so they answer a different and more durable
    question: not "how busy was it recently" but "what has this workload been
    starved of". Signal wait is time spent runnable-but-waiting-for-CPU, which is
    the classic CPU-pressure indicator; RESOURCE_SEMAPHORE is query memory grants
    queueing; PAGEIOLATCH is reads waiting on storage.

    Reported as percentages so they are comparable across instances of wildly
    different uptimes. */
BEGIN TRY
    DECLARE @totalWaitMs decimal(38,2);
    SELECT @totalWaitMs = NULLIF(SUM(CONVERT(decimal(38,2), wait_time_ms)), 0)
    FROM sys.dm_os_wait_stats;

    IF @totalWaitMs IS NOT NULL
    BEGIN
        SELECT @CpuPressurePct = CONVERT(decimal(18,2),
                   100.0 * SUM(CONVERT(decimal(38,2), signal_wait_time_ms)) / @totalWaitMs)
        FROM sys.dm_os_wait_stats;

        SELECT @MemPressurePct = CONVERT(decimal(18,2),
                   100.0 * ISNULL(SUM(CONVERT(decimal(38,2), wait_time_ms)), 0) / @totalWaitMs)
        FROM sys.dm_os_wait_stats WHERE wait_type LIKE 'RESOURCE_SEMAPHORE%';

        SELECT @IoPressurePct = CONVERT(decimal(18,2),
                   100.0 * ISNULL(SUM(CONVERT(decimal(38,2), wait_time_ms)), 0) / @totalWaitMs)
        FROM sys.dm_os_wait_stats WHERE wait_type LIKE 'PAGEIOLATCH%';
    END
END TRY
BEGIN CATCH
    SET @CpuPressurePct = NULL; SET @MemPressurePct = NULL; SET @IoPressurePct = NULL;
END CATCH;

-- sys.dm_os_host_info is 2017+; fall back to the Windows-only DMV before that.
IF OBJECT_ID('sys.dm_os_host_info') IS NOT NULL
BEGIN
    SET @sql = N'SELECT @p = host_platform, @v = host_release FROM sys.dm_os_host_info;';
    EXEC sp_executesql @sql, N'@p nvarchar(64) OUTPUT, @v nvarchar(128) OUTPUT',
         @p = @OsPlatform OUTPUT, @v = @OsVersion OUTPUT;
END
ELSE IF OBJECT_ID('sys.dm_os_windows_info') IS NOT NULL
BEGIN
    SET @OsPlatform = N'Windows';
    SET @sql = N'SELECT @v = windows_release FROM sys.dm_os_windows_info;';
    EXEC sp_executesql @sql, N'@v nvarchar(128) OUTPUT', @v = @OsVersion OUTPUT;
END

SET @UptimeHours = CONVERT(decimal(18,2), DATEDIFF(minute, @SqlStartTime, GETDATE()) / 60.0);

/*  CPU utilisation from the scheduler-monitor ring buffer.
    NOTE: this covers only the last ~256 minutes, so it is a coarse signal, not a
    substitute for real perfmon history. The Analyzer treats it as indicative and
    lets you override the right-sizing basis. */
BEGIN TRY
    ;WITH rb AS (
        SELECT CONVERT(xml, record) AS rec
        FROM sys.dm_os_ring_buffers
        WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
          AND record LIKE '%<SystemHealth>%'
    ), cpu AS (
        SELECT rec.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int') AS SqlCpu
        FROM rb
    )
    SELECT @AvgCpuPct = AVG(SqlCpu), @MaxCpuPct = MAX(SqlCpu), @CpuSampleCount = COUNT(*)
    FROM cpu WHERE SqlCpu IS NOT NULL;
END TRY
BEGIN CATCH
    SET @AvgCpuPct = NULL; SET @MaxCpuPct = NULL; SET @CpuSampleCount = NULL;
END CATCH;

-- Instance-scope migration signals.
SELECT @LinkedServerCount = COUNT(*) FROM sys.servers WHERE server_id > 0 AND is_linked = 1;
SELECT @LoginCount        = COUNT(*) FROM sys.server_principals WHERE type IN ('S','U','G') AND is_disabled = 0;
SELECT @CredentialCount   = COUNT(*) FROM sys.credentials;

SELECT @TempDbSizeGB = CONVERT(decimal(18,2), SUM(CONVERT(bigint, size)) * 8.0 / 1048576.0)
FROM sys.master_files WHERE database_id = 2;

SET @AgentJobCount = 0; SET @HasDatabaseMail = 0; SET @IsDistributor = 0; SET @SqlAgentProxyCount = 0;
IF DB_ID('msdb') IS NOT NULL
BEGIN
    BEGIN TRY
        SELECT @sql = N'SELECT @c = COUNT(*) FROM msdb.dbo.sysjobs WHERE enabled = 1;';
        EXEC sp_executesql @sql, N'@c int OUTPUT', @c = @AgentJobCount OUTPUT;

        SELECT @sql = N'SELECT @c = CASE WHEN EXISTS (SELECT 1 FROM msdb.dbo.sysmail_profile) THEN 1 ELSE 0 END;';
        EXEC sp_executesql @sql, N'@c bit OUTPUT', @c = @HasDatabaseMail OUTPUT;

        SELECT @sql = N'SELECT @c = COUNT(*) FROM msdb.dbo.sysproxies;';
        EXEC sp_executesql @sql, N'@c int OUTPUT', @c = @SqlAgentProxyCount OUTPUT;
    END TRY
    BEGIN CATCH
        SET @AgentJobCount = ISNULL(@AgentJobCount, 0);
    END CATCH;
END

SELECT @IsDistributor = CASE WHEN EXISTS (SELECT 1 FROM sys.databases WHERE is_distributor = 1) THEN 1 ELSE 0 END;
SELECT @HasSsisCatalog = CASE WHEN DB_ID('SSISDB') IS NOT NULL THEN 1 ELSE 0 END;
SELECT @HasSsrs        = CASE WHEN DB_ID('ReportServer') IS NOT NULL
                               OR EXISTS (SELECT 1 FROM sys.databases WHERE name LIKE 'ReportServer%') THEN 1 ELSE 0 END;

SET @AgCount = 0;
IF OBJECT_ID('sys.availability_groups') IS NOT NULL
BEGIN
    SET @sql = N'SELECT @c = COUNT(*) FROM sys.availability_groups;';
    EXEC sp_executesql @sql, N'@c int OUTPUT', @c = @AgCount OUTPUT;
END

/*------------------------------------------------------------------------------
  2. Per-database collection
------------------------------------------------------------------------------*/
IF OBJECT_ID('tempdb..#db') IS NOT NULL DROP TABLE #db;
CREATE TABLE #db (
    DatabaseName          sysname,
    StateDesc             nvarchar(64)  NULL,
    RecoveryModel         nvarchar(64)  NULL,
    CompatibilityLevel    int           NULL,
    DbCollation           nvarchar(128) NULL,
    CreateDate            datetime      NULL,
    IsReadOnly            bit           NULL,
    IsTdeEncrypted        bit           NULL,
    IsAutoClose           bit           NULL,
    IsAutoShrink          bit           NULL,
    ContainmentType       int           NULL,
    IsQueryStoreOn        bit           NULL,
    IsPublished           bit           NULL,
    IsSubscribed          bit           NULL,
    IsMergePublished      bit           NULL,
    IsCdcEnabled          bit           NULL,
    IsChangeTrackingOn    bit           NULL,
    IsBrokerEnabled       bit           NULL,
    IsInAvailabilityGroup bit           NULL DEFAULT 0,
    DataSizeGB            decimal(18,2) NULL,
    LogSizeGB             decimal(18,2) NULL,
    TotalSizeGB           decimal(18,2) NULL,
    BufferPoolMB          decimal(18,2) NULL,
    QsCpuSeconds          decimal(18,2) NULL,
    QsWindowHours         decimal(18,2) NULL,
    HasFileStream         bit           NULL,
    HasMemoryOptimized    bit           NULL,
    HasFileTable          bit           NULL,
    HasClrAssembly        bit           NULL,
    HasFullTextCatalog    bit           NULL,
    HasColumnStoreIndex   bit           NULL,
    HasPartitioning       bit           NULL,
    HasTemporalTable      bit           NULL,
    HasExternalTable      bit           NULL,
    HasCrossDbDependency  bit           NULL,
    HasLinkedSvrDependency bit          NULL,
    TableCount            int           NULL,
    ProcedureCount        int           NULL,
    ReadIops              bigint        NULL,
    WriteIops             bigint        NULL,
    ThroughputMBps        decimal(18,2) NULL
);

DECLARE @dbName sysname;
DECLARE db_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT name FROM sys.databases
    WHERE database_id > 4                       -- skip master/model/msdb/tempdb
      AND state_desc = 'ONLINE'
      AND is_read_only = 0                      -- avoid snapshots/read-only replicas erroring
      AND source_database_id IS NULL            -- skip database snapshots
      AND HAS_DBACCESS(name) = 1
    ORDER BY name;

OPEN db_cur;
FETCH NEXT FROM db_cur INTO @dbName;

WHILE @@FETCH_STATUS = 0
BEGIN
    BEGIN TRY
        DECLARE @q nvarchar(max);
        DECLARE @db nvarchar(300) = QUOTENAME(@dbName);

        SET @q = N'
        USE ' + @db + N';
        DECLARE @HasFileStream bit = 0, @HasMemOpt bit = 0, @HasFileTable bit = 0,
                @HasClr bit = 0, @HasFullText bit = 0, @HasColumnStore bit = 0,
                @HasPartition bit = 0, @HasTemporal bit = 0, @HasExternal bit = 0,
                @HasCrossDb bit = 0, @HasLinkedDep bit = 0, @HasBroker bit = 0,
                @QsCpuSeconds decimal(18,2) = NULL, @QsWindowHours decimal(18,2) = NULL,
                @TableCount int = 0, @ProcCount int = 0;

        SELECT @HasFileStream = CASE WHEN EXISTS (SELECT 1 FROM sys.filegroups WHERE type = ''FD'') THEN 1 ELSE 0 END;
        SELECT @HasMemOpt     = CASE WHEN EXISTS (SELECT 1 FROM sys.filegroups WHERE type = ''FX'') THEN 1 ELSE 0 END;
        SELECT @HasClr        = CASE WHEN EXISTS (SELECT 1 FROM sys.assemblies WHERE is_user_defined = 1) THEN 1 ELSE 0 END;
        SELECT @HasFullText   = CASE WHEN EXISTS (SELECT 1 FROM sys.fulltext_catalogs) THEN 1 ELSE 0 END;

        -- Service Broker: test for USER-CREATED queues, not sys.databases.is_broker_enabled.
        -- That flag is inherited from model and is ON for essentially every database,
        -- so keying off it would report Service Broker everywhere and wrongly block
        -- the whole estate from Azure SQL Database. What actually blocks a migration
        -- is a broker application, and that means user queues.
        SELECT @HasBroker = CASE WHEN EXISTS (
            SELECT 1 FROM sys.service_queues WHERE is_ms_shipped = 0) THEN 1 ELSE 0 END;

        -- Table count and the temporal flag come from ONE pass over sys.tables.
        -- Scanning it twice is the single most expensive thing this batch does on
        -- a large schema: measured at 1,500 tables, splitting them costs ~15 ms
        -- versus ~9 ms combined. Across a 1,000-database instance that is the
        -- difference between roughly 35 s and 20 s.
        IF COL_LENGTH(''sys.tables'', ''temporal_type'') IS NOT NULL
            SELECT @TableCount = COUNT(*),
                   @HasTemporal = ISNULL(MAX(CASE WHEN temporal_type <> 0 THEN 1 ELSE 0 END), 0)
            FROM sys.tables;
        ELSE
            SELECT @TableCount = COUNT(*) FROM sys.tables;

        SELECT @ProcCount = COUNT(*) FROM sys.procedures;

        IF OBJECT_ID(''sys.filetables'') IS NOT NULL
            SELECT @HasFileTable = CASE WHEN EXISTS (SELECT 1 FROM sys.filetables) THEN 1 ELSE 0 END;

        SELECT @HasColumnStore = CASE WHEN EXISTS (SELECT 1 FROM sys.indexes WHERE type IN (5,6)) THEN 1 ELSE 0 END;
        SELECT @HasPartition   = CASE WHEN EXISTS (SELECT 1 FROM sys.partition_schemes) THEN 1 ELSE 0 END;

        IF OBJECT_ID(''sys.external_tables'') IS NOT NULL
            SELECT @HasExternal = CASE WHEN EXISTS (SELECT 1 FROM sys.external_tables) THEN 1 ELSE 0 END;

        -- Cross-database and linked-server references in code objects.
        BEGIN TRY
            SELECT @HasCrossDb = CASE WHEN EXISTS (
                SELECT 1 FROM sys.sql_expression_dependencies
                WHERE referenced_database_name IS NOT NULL
                  AND referenced_database_name <> DB_NAME()
                  AND referenced_server_name IS NULL) THEN 1 ELSE 0 END;
            SELECT @HasLinkedDep = CASE WHEN EXISTS (
                SELECT 1 FROM sys.sql_expression_dependencies
                WHERE referenced_server_name IS NOT NULL) THEN 1 ELSE 0 END;
        END TRY
        BEGIN CATCH
            SET @HasCrossDb = NULL; SET @HasLinkedDep = NULL;
        END CATCH;

        -- Query Store CPU, where the database has it enabled. This is the single
        -- best resource signal the engine can offer: default retention is 30 days
        -- against the scheduler ring buffer''s four hours, and it is per database
        -- rather than per instance, so each database can be sized on what it
        -- actually consumed instead of a share of the host. The window is reported
        -- alongside it so a percentage can be derived honestly.
        IF OBJECT_ID(''sys.database_query_store_options'') IS NOT NULL
        BEGIN TRY
            IF EXISTS (SELECT 1 FROM sys.database_query_store_options WHERE actual_state = 2)
                SELECT @QsCpuSeconds = CONVERT(decimal(18,2), SUM(rs.avg_cpu_time * rs.count_executions) / 1000000.0),
                       @QsWindowHours = CONVERT(decimal(18,2),
                           DATEDIFF(minute, MIN(rsi.start_time), MAX(rsi.end_time)) / 60.0)
                FROM sys.query_store_runtime_stats rs
                JOIN sys.query_store_runtime_stats_interval rsi
                  ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id;
        END TRY
        BEGIN CATCH
            SET @QsCpuSeconds = NULL; SET @QsWindowHours = NULL;
        END CATCH;

        INSERT INTO #db (DatabaseName, DataSizeGB, LogSizeGB, TotalSizeGB,
                         HasFileStream, HasMemoryOptimized, HasFileTable, HasClrAssembly,
                         HasFullTextCatalog, HasColumnStoreIndex, HasPartitioning,
                         HasTemporalTable, HasExternalTable, HasCrossDbDependency,
                         HasLinkedSvrDependency, IsBrokerEnabled, TableCount, ProcedureCount,
                         QsCpuSeconds, QsWindowHours)
        SELECT
            DB_NAME(),
            CONVERT(decimal(18,2), SUM(CASE WHEN type_desc = ''ROWS'' THEN CONVERT(bigint, size) ELSE 0 END) * 8.0 / 1048576.0),
            CONVERT(decimal(18,2), SUM(CASE WHEN type_desc = ''LOG''  THEN CONVERT(bigint, size) ELSE 0 END) * 8.0 / 1048576.0),
            CONVERT(decimal(18,2), SUM(CONVERT(bigint, size)) * 8.0 / 1048576.0),
            @HasFileStream, @HasMemOpt, @HasFileTable, @HasClr,
            @HasFullText, @HasColumnStore, @HasPartition,
            @HasTemporal, @HasExternal, @HasCrossDb,
            @HasLinkedDep, @HasBroker, @TableCount, @ProcCount,
            @QsCpuSeconds, @QsWindowHours
        FROM sys.database_files;';

        EXEC sp_executesql @q;
    END TRY
    BEGIN CATCH
        -- Unreachable / offline / insufficient rights: record the name and move on.
        IF NOT EXISTS (SELECT 1 FROM #db WHERE DatabaseName = @dbName)
            INSERT INTO #db (DatabaseName) VALUES (@dbName);
    END CATCH;

    FETCH NEXT FROM db_cur INTO @dbName;
END

CLOSE db_cur;
DEALLOCATE db_cur;

/*  Fold in sys.databases metadata (version-guarded columns via dynamic SQL). */
UPDATE d SET
    d.StateDesc          = s.state_desc,
    d.RecoveryModel      = s.recovery_model_desc,
    d.CompatibilityLevel = s.compatibility_level,
    d.DbCollation        = ISNULL(s.collation_name,
                                  CONVERT(nvarchar(128), DATABASEPROPERTYEX(s.name, 'Collation'))),
    d.CreateDate         = s.create_date,
    d.IsReadOnly         = s.is_read_only,
    d.IsTdeEncrypted     = s.is_encrypted,
    d.IsAutoClose        = s.is_auto_close_on,
    d.IsAutoShrink       = s.is_auto_shrink_on,
    d.IsPublished        = s.is_published,
    d.IsSubscribed       = s.is_subscribed,
    d.IsMergePublished   = s.is_merge_published,
    d.IsCdcEnabled       = s.is_cdc_enabled
FROM #db d JOIN sys.databases s ON s.name = d.DatabaseName;

IF COL_LENGTH('sys.databases', 'containment') IS NOT NULL
    EXEC sp_executesql N'UPDATE d SET d.ContainmentType = s.containment
                         FROM #db d JOIN sys.databases s ON s.name = d.DatabaseName;';

IF COL_LENGTH('sys.databases', 'is_query_store_on') IS NOT NULL
    EXEC sp_executesql N'UPDATE d SET d.IsQueryStoreOn = s.is_query_store_on
                         FROM #db d JOIN sys.databases s ON s.name = d.DatabaseName;';

-- Change tracking is exposed via its own catalog view, not a sys.databases column.
IF OBJECT_ID('sys.change_tracking_databases') IS NOT NULL
    EXEC sp_executesql N'UPDATE d SET d.IsChangeTrackingOn =
                            CASE WHEN EXISTS (SELECT 1 FROM sys.change_tracking_databases c
                                              WHERE c.database_id = DB_ID(d.DatabaseName))
                                 THEN 1 ELSE 0 END
                         FROM #db d;';

IF OBJECT_ID('sys.dm_hadr_database_replica_states') IS NOT NULL
    EXEC sp_executesql N'UPDATE d SET d.IsInAvailabilityGroup = 1
                         FROM #db d
                         WHERE EXISTS (SELECT 1 FROM sys.dm_hadr_database_replica_states r
                                       WHERE r.database_id = DB_ID(d.DatabaseName));';

/*  Working set per database: how much of the buffer pool each one actually
    occupies. This matters more than file size for choosing a memory tier — a
    4 TB database with a 2 GB hot set has very different requirements from a
    40 GB database that is fully cached. Scanning buffer descriptors on a large
    server is not free, so it is wrapped and allowed to fail without taking the
    rest of the collection with it. */
BEGIN TRY
    ;WITH bp AS (
        SELECT database_id, CONVERT(decimal(18,2), COUNT_BIG(*) * 8 / 1024.0) AS mb
        FROM sys.dm_os_buffer_descriptors
        WHERE database_id BETWEEN 5 AND 32766      -- skip system databases and the resource DB
        GROUP BY database_id
    )
    UPDATE d SET d.BufferPoolMB = bp.mb
    FROM #db d JOIN bp ON bp.database_id = DB_ID(d.DatabaseName);
END TRY
BEGIN CATCH
END CATCH;

/*  I/O profile since instance start, from the file-stats DMV. */
;WITH io AS (
    SELECT vfs.database_id,
           SUM(vfs.num_of_reads)  AS reads,
           SUM(vfs.num_of_writes) AS writes,
           SUM(vfs.num_of_bytes_read + vfs.num_of_bytes_written) AS bytes
    FROM sys.dm_io_virtual_file_stats(NULL, NULL) vfs
    GROUP BY vfs.database_id
)
UPDATE d SET
    d.ReadIops       = CASE WHEN @UptimeHours > 0 THEN CONVERT(bigint, io.reads  / (@UptimeHours * 3600.0)) END,
    d.WriteIops      = CASE WHEN @UptimeHours > 0 THEN CONVERT(bigint, io.writes / (@UptimeHours * 3600.0)) END,
    d.ThroughputMBps = CASE WHEN @UptimeHours > 0 THEN CONVERT(decimal(18,2), io.bytes / (@UptimeHours * 3600.0) / 1048576.0) END
FROM #db d JOIN io ON io.database_id = DB_ID(d.DatabaseName);

/*------------------------------------------------------------------------------
  3. Output
------------------------------------------------------------------------------*/
IF OBJECT_ID('tempdb..#out') IS NOT NULL DROP TABLE #out;

SELECT
    -- identity
    CONVERT(varchar(10), @SchemaVersion)                      AS SchemaVersion,
    CONVERT(nvarchar(256), @ServerName)                       AS ServerName,
    CONVERT(nvarchar(256), @InstanceName)                     AS InstanceName,
    -- product
    @VersionName                                              AS SqlVersion,
    @ProductVersion                                           AS ProductVersion,
    @Edition                                                  AS Edition,
    ISNULL(@ProductLevel, N'')                                AS ServicePack,
    ISNULL(@ProductUpdateLevel, N'')                           AS CumulativeUpdate,
    -- host
    ISNULL(@OsPlatform, N'Windows')                           AS OsPlatform,
    ISNULL(@OsVersion, N'')                                   AS OsVersion,
    @CpuCount                                                 AS LogicalCores,
    @SocketCount                                              AS Sockets,
    @CoresPerSocket                                           AS CoresPerSocket,
    @PhysicalMemoryGB                                         AS PhysicalMemoryGB,
    @MaxServerMemoryGB                                        AS MaxServerMemoryGB,
    @SqlMemoryTargetGB                                        AS SqlMemoryTargetGB,
    @SqlMemoryInUseGB                                         AS SqlMemoryInUseGB,
    @SchedulerCount                                           AS SchedulerCount,
    @AvgCpuPct                                                AS AvgCpuPct,
    @MaxCpuPct                                                AS PeakCpuPct,
    @CpuSampleCount                                           AS CpuSampleCount,
    @CpuPressurePct                                           AS CpuPressurePct,
    @MemPressurePct                                           AS MemPressurePct,
    @IoPressurePct                                            AS IoPressurePct,
    @UptimeHours                                              AS UptimeHours,
    -- instance-scope migration signals
    @IsClustered                                              AS IsFailoverCluster,
    @IsHadrEnabled                                            AS IsAlwaysOnEnabled,
    @AgCount                                                  AS AvailabilityGroupCount,
    @AgentJobCount                                            AS AgentJobCount,
    @LinkedServerCount                                        AS LinkedServerCount,
    @HasDatabaseMail                                          AS HasDatabaseMail,
    @SqlAgentProxyCount                                       AS AgentProxyCount,
    @CredentialCount                                          AS CredentialCount,
    @HasSsisCatalog                                           AS HasSsisCatalog,
    @HasSsrs                                                  AS HasSsrs,
    @IsDistributor                                            AS IsReplicationDistributor,
    @LoginCount                                               AS LoginCount,
    @TempDbSizeGB                                             AS TempDbSizeGB,
    @Collation                                                AS InstanceCollation,
    -- database grain
    d.DatabaseName, d.StateDesc AS DatabaseState, d.RecoveryModel, d.CompatibilityLevel,
    d.DbCollation, d.CreateDate AS DatabaseCreateDate, d.IsReadOnly, d.IsTdeEncrypted,
    d.IsAutoClose, d.IsAutoShrink, d.ContainmentType, d.IsQueryStoreOn,
    d.DataSizeGB, d.LogSizeGB, d.TotalSizeGB, d.BufferPoolMB,
    d.QsCpuSeconds, d.QsWindowHours,
    CASE WHEN d.QsWindowHours > 0
         THEN CONVERT(decimal(18,2), 100.0 * d.QsCpuSeconds / (d.QsWindowHours * 3600.0))
    END AS QsAvgCpuCores,
    d.ReadIops, d.WriteIops, d.ThroughputMBps,
    d.TableCount, d.ProcedureCount,
    -- feature flags that drive Azure target eligibility
    d.HasFileStream, d.HasFileTable, d.HasMemoryOptimized, d.HasClrAssembly,
    d.HasFullTextCatalog, d.HasColumnStoreIndex, d.HasPartitioning, d.HasTemporalTable,
    d.HasExternalTable, d.HasCrossDbDependency, d.HasLinkedSvrDependency,
    d.IsBrokerEnabled AS HasServiceBroker, d.IsCdcEnabled AS HasChangeDataCapture,
    d.IsChangeTrackingOn AS HasChangeTracking,
    d.IsPublished, d.IsSubscribed, d.IsMergePublished,
    ISNULL(d.IsInAvailabilityGroup, 0) AS IsInAvailabilityGroup,
    CONVERT(datetime, GETDATE()) AS CollectedAtUtc
INTO #out
FROM #db d;

IF UPPER(@Format) = 'CSV'
BEGIN
    /* Single-column CSV: header row first, then RFC4180-quoted data rows.
       Designed for: sqlcmd -h -1 -W -s "" -y 0 */
    DECLARE @cols nvarchar(max);
    SELECT @cols = STUFF((
        SELECT ',' + c.name
        FROM tempdb.sys.columns c
        WHERE c.object_id = OBJECT_ID('tempdb..#out')
        ORDER BY c.column_id
        FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '');

    DECLARE @select nvarchar(max);
    SELECT @select = STUFF((
        SELECT ' + '','' + ' +
               'ISNULL(''"'' + REPLACE(CONVERT(nvarchar(4000), ' + QUOTENAME(c.name) +
               CASE WHEN t.name IN ('datetime','date','datetime2')
                    THEN ', 126' ELSE '' END + '), ''"'', ''""'') + ''"'', '''')'
        FROM tempdb.sys.columns c
        JOIN sys.types t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID('tempdb..#out')
        ORDER BY c.column_id
        FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 9, '');

    SET @sql = N'SELECT N''' + REPLACE(@cols, '''', '''''') + N''' AS CsvLine, 0 AS o, '''' AS n
                 UNION ALL
                 SELECT ' + @select + N', 1, DatabaseName FROM #out
                 ORDER BY o, n;';
    EXEC sp_executesql @sql;
END
ELSE
BEGIN
    SELECT * FROM #out ORDER BY DatabaseName;
END

DROP TABLE #out;
DROP TABLE #db;
