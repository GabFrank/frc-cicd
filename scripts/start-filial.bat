@echo off
setlocal enabledelayedexpansion

set BASE_DIR=C:\frc-filial
set JAR=%BASE_DIR%\current\frc-filial-server.jar

:: Read .env and build -D flags
set JAVA_ARGS=
for /f "usebackq tokens=1,* delims==" %%A in ("%BASE_DIR%\.env") do (
    set "KEY=%%A"
    set "VAL=%%B"
    :: Convert KEY to lowercase and replace _ with .
    set "KEY=!KEY:_=.!"
    call :toLower KEY
    set "JAVA_ARGS=!JAVA_ARGS! -D!KEY!=!VAL!"
)

java !JAVA_ARGS! -jar "%JAR%"
goto :eof

:toLower
for %%i in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do (
    set "%1=!%1:%%i=%%i!"
)
goto :eof
